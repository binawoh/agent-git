use crate::state::{Repository, State};
use agit::domain::{meta, storage};
use anyhow::{Context, Result, ensure};
use std::collections::HashSet;
use std::io::{BufRead, Read};
use std::path::Path;
use std::process::{Command, Stdio};

pub fn command(repo: &Path) -> Command {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    command
}

pub fn output(repo: &Path, args: &[&str]) -> Result<String> {
    let result = command(repo).args(args).output()?;
    ensure!(
        result.status.success(),
        "Git {}: {}",
        args.first().unwrap_or(&""),
        String::from_utf8_lossy(&result.stderr).trim()
    );
    String::from_utf8(result.stdout).context("Git output is not UTF-8")
}

pub fn blob(repo: &Path, oid: &str, path: &str, limit: usize) -> Result<Vec<u8>> {
    ensure!(meta::is_event_id(oid), "Invalid immutable commit");
    let spec = format!("{oid}:{path}");
    let size: usize = output(repo, &["cat-file", "-s", &spec])?.trim().parse()?;
    ensure!(size <= limit, "Blob exceeds configured read limit");
    let mut child = command(repo)
        .args(["cat-file", "blob", &spec])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut bytes = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        let _ = child.kill();
    }
    ensure!(
        child.wait()?.success() && bytes.len() == size,
        "Incomplete or oversized Git blob"
    );
    Ok(bytes)
}

pub fn snapshot_meta(repo: &Path, oid: &str) -> Result<meta::Meta> {
    let bytes = blob(repo, oid, meta::FILE, 1024 * 1024)?;
    meta::parse_strict(std::str::from_utf8(&bytes)?, oid)
}

pub fn resolve(repo: &Path, reference: &str) -> Result<String> {
    ensure!(
        !reference.is_empty()
            && reference.len() <= 256
            && !reference.starts_with('-')
            && !reference.contains(['\n', '\r', '\0']),
        "Invalid saved reference"
    );
    let oid = output(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{reference}^{{commit}}"),
        ],
    )?
    .trim()
    .to_owned();
    ensure!(meta::is_event_id(&oid), "Expected a SHA-1 commit");
    let reachable = output(
        repo,
        &[
            "for-each-ref",
            "--contains",
            &oid,
            "--format=%(refname)",
            "refs/heads",
            "refs/tags",
        ],
    )?;
    ensure!(
        !reachable.trim().is_empty(),
        "Commit is not in published history"
    );
    Ok(oid)
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "/").replace('\'', "'\"'\"'"))
}

pub fn initialize(state: &State, repo: &Repository) -> Result<()> {
    let path = state.repo_path(repo);
    ensure!(!path.exists(), "Repository identity path already exists");
    let result = Command::new("git")
        .args(["init", "--bare", "--initial-branch=main"])
        .arg(&path)
        .output()?;
    ensure!(result.status.success(), "Cannot initialize Git repository");
    for (key, value) in [
        ("http.receivepack", "true"),
        ("receive.denyNonFastForwards", "true"),
        ("receive.denyDeletes", "true"),
        ("receive.fsckObjects", "true"),
        ("transfer.fsckObjects", "true"),
        ("receive.advertiseAtomic", "true"),
        ("core.logAllRefUpdates", "true"),
    ] {
        output(&path, &["config", key, value])?;
    }
    let executable = std::env::current_exe()?;
    let hook = path.join("hooks/pre-receive");
    std::fs::write(
        &hook,
        format!(
            "#!/bin/sh\nexec {} --data {} validate-receive\n",
            shell_quote(&executable.to_string_lossy()),
            shell_quote(&state.root.to_string_lossy())
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(hook, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

fn validate_snapshot(
    state: &State,
    repo: &Path,
    oid: &str,
    verified_lfs: &mut HashSet<(String, u64)>,
) -> Result<meta::Meta> {
    let snapshot = snapshot_meta(repo, oid)?;
    validate_lfs(state, repo, oid, verified_lfs)?;
    if snapshot.is_file_line() {
        return Ok(snapshot);
    }
    let (log, view) = storage::materialize_quarantined_pair_bounded(
        repo,
        oid,
        state.config.max_snapshot_mib * 1024 * 1024,
    )?;
    let envelopes = storage::parse_envelopes(&log)?;
    let log_ids: HashSet<_> = log
        .split_inclusive('\n')
        .map(storage::event_id)
        .collect::<Result<_>>()?;
    for line in view.split_inclusive('\n') {
        ensure!(
            log_ids.contains(&storage::event_id(line)?),
            "VIEW references content absent from LOG"
        );
    }
    ensure!(
        storage::unbalanced_view_markers(&view)? == 0,
        "VIEW has unmatched merge markers"
    );
    ensure!(
        envelopes
            .iter()
            .all(|e| agit::adapter::normalize(&e.source).is_ok()),
        "Unknown envelope runtime"
    );
    Ok(snapshot)
}

fn validate_lfs(
    state: &State,
    repo: &Path,
    oid: &str,
    verified: &mut HashSet<(String, u64)>,
) -> Result<()> {
    let repository = repo
        .file_stem()
        .and_then(|v| v.to_str())
        .context("Invalid repository path")?;
    let tree = output(
        repo,
        &[
            "ls-tree",
            "-r",
            "--format=%(objecttype) %(objectname) %(objectsize)",
            oid,
        ],
    )?;
    for row in tree.lines() {
        let fields: Vec<_> = row.split_whitespace().collect();
        if fields.len() != 3 || fields[0] != "blob" {
            continue;
        }
        let size: usize = fields[2].parse()?;
        if size > agit::domain::lfs::POINTER_LIMIT {
            continue;
        }
        let result = command(repo)
            .args(["cat-file", "blob", fields[1]])
            .output()?;
        ensure!(result.status.success(), "Cannot inspect LFS pointer");
        if let Some(pointer) = agit::domain::lfs::Pointer::parse(&result.stdout)? {
            if verified.contains(&(pointer.oid.clone(), pointer.size)) {
                continue;
            }
            let file =
                std::fs::File::open(state.root.join("lfs").join(repository).join(&pointer.oid))
                    .context("Upload the referenced LFS object before publishing Git history")?;
            pointer.verify(file)?;
            verified.insert((pointer.oid, pointer.size));
        }
    }
    Ok(())
}

/// Multi-ref publication must either update every ref or update none.
pub fn validate_push_commands(input: &mut impl Read) -> Result<()> {
    let mut count = 0;
    let mut shallow = 0;
    let mut atomic = false;
    loop {
        let mut prefix = [0u8; 4];
        input.read_exact(&mut prefix)?;
        let length = usize::from_str_radix(std::str::from_utf8(&prefix)?, 16)?;
        if length == 0 {
            break;
        }
        ensure!((4..=65520).contains(&length), "Invalid Git packet length");
        let mut packet = vec![0; length - 4];
        input.read_exact(&mut packet)?;
        if packet.starts_with(b"shallow ") {
            shallow += 1;
            ensure!(count == 0 && shallow <= 1024, "Invalid shallow declaration");
            ensure!(
                meta::is_event_id(std::str::from_utf8(&packet[8..])?.trim_end()),
                "Invalid shallow object id"
            );
            continue;
        }
        count += 1;
        ensure!(count <= 1024, "Too many ref updates");
        if count == 1
            && let Some(pos) = packet.iter().position(|b| *b == 0)
        {
            atomic = std::str::from_utf8(&packet[pos + 1..])?
                .split_whitespace()
                .any(|s| s == "atomic");
        }
    }
    ensure!(
        count <= 1 || atomic,
        "Multiple ref updates require git push --atomic"
    );
    Ok(())
}

pub fn validate_receive(state: &State, repo: &Path) -> Result<()> {
    let real = dunce::canonicalize(repo)?;
    ensure!(
        real.parent() == Some(state.root.join("repos").as_path()),
        "Hook is outside this Hub's repositories"
    );
    let mut updates = Vec::new();
    for line in std::io::stdin().lock().lines().take(1025) {
        let line = line?;
        let parts: Vec<_> = line.split_whitespace().map(str::to_owned).collect();
        ensure!(
            parts.len() == 3 && meta::is_event_id(&parts[0]) && meta::is_event_id(&parts[1]),
            "Invalid ref update"
        );
        updates.push(parts);
    }
    ensure!(updates.len() <= 1024, "Too many ref updates");
    let zero = "0".repeat(40);
    let mut checked = HashSet::new();
    let mut verified_lfs = HashSet::new();
    for change in &updates {
        let (old, new, name) = (&change[0], &change[1], &change[2]);
        ensure!(new != &zero, "Published refs cannot be deleted");
        ensure!(
            name.starts_with("refs/heads/") || name.starts_with("refs/tags/"),
            "Unsupported ref namespace"
        );
        let commit = output(
            repo,
            &["rev-parse", "--verify", &format!("{new}^{{commit}}")],
        )?
        .trim()
        .to_owned();
        let new_meta = if checked.insert(commit.clone()) {
            validate_snapshot(state, repo, &commit, &mut verified_lfs)?
        } else {
            snapshot_meta(repo, &commit)?
        };
        if name.starts_with("refs/tags/") {
            if name.starts_with("refs/tags/agit-") {
                ensure!(
                    name == &format!("refs/tags/agit-{commit}"),
                    "Version tag must match its commit"
                );
            }
            ensure!(
                old == &zero || old == new,
                "Published version tags are immutable"
            );
        } else if old != &zero {
            ensure!(
                command(repo)
                    .args(["merge-base", "--is-ancestor", old, new])
                    .status()?
                    .success(),
                "Published branches must fast-forward"
            );
            let previous = snapshot_meta(repo, old)?;
            ensure!(
                previous.line == new_meta.line,
                "Branch line type cannot change"
            );
            ensure!(
                previous.session.is_empty() || previous.session == new_meta.session,
                "Branch session identity cannot change"
            );
        }
        let new_commits = output(
            repo,
            &["rev-list", "--max-count=10001", new, "--not", "--all"],
        )?;
        ensure!(
            new_commits.lines().count() <= 10000,
            "Push has too many new commits; upload smaller batches"
        );
        for oid in new_commits.lines() {
            if checked.insert(oid.to_owned()) {
                validate_snapshot(state, repo, oid, &mut verified_lfs)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_push_commands;

    fn commands(atomic: bool, count: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        for i in 0..count {
            let capabilities = if i == 0 {
                if atomic {
                    "\0report-status atomic"
                } else {
                    "\0report-status"
                }
            } else {
                ""
            };
            let command = format!(
                "{} {} refs/heads/branch-{i}{capabilities}\n",
                "0".repeat(40),
                "a".repeat(40)
            );
            bytes.extend_from_slice(format!("{:04x}{command}", command.len() + 4).as_bytes());
        }
        bytes.extend_from_slice(b"0000");
        bytes
    }

    #[test]
    fn multiple_ref_updates_require_atomic_negotiation() {
        assert!(validate_push_commands(&mut commands(false, 1).as_slice()).is_ok());
        assert!(validate_push_commands(&mut commands(true, 2).as_slice()).is_ok());
        assert!(validate_push_commands(&mut commands(false, 2).as_slice()).is_err());
        assert!(validate_push_commands(&mut b"0008x".as_slice()).is_err());
        let shallow = format!("shallow {}\n", "c".repeat(40));
        let prefix = format!("{:04x}{shallow}", shallow.len() + 4).into_bytes();
        let mut atomic = prefix.clone();
        atomic.extend(commands(true, 2));
        assert!(validate_push_commands(&mut atomic.as_slice()).is_ok());
        let mut non_atomic = prefix;
        non_atomic.extend(commands(false, 2));
        assert!(validate_push_commands(&mut non_atomic.as_slice()).is_err());
    }
}
