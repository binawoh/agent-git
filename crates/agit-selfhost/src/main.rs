mod git;
mod http;
mod index;
mod state;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(version, about)]
struct Args {
    /// Private data directory, outside source repositories.
    #[arg(long)]
    data: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Initialize a single-owner Hub; print its initial PAT once.
    Init {
        #[arg(long)]
        owner: String,
        #[arg(long)]
        public_url: String,
        #[arg(long, default_value_t = 64)]
        max_snapshot_mib: usize,
        #[arg(long, default_value_t = 256)]
        max_upload_mib: u64,
    },
    /// Run behind an HTTPS reverse proxy; loopback is the default.
    Serve {
        #[arg(long, default_value = "127.0.0.1:8177")]
        listen: String,
    },
    /// Issue a new PAT and print it once.
    IssueToken {
        #[arg(long, default_value = "client")]
        label: String,
    },
    /// List token identifiers and labels, never token values.
    ListTokens,
    /// Revoke a PAT and all sessions created with it.
    RevokeToken { id: String },
    /// Rebuild derived search data from saved Git history.
    Reindex,
    /// Validate Git's pre-receive input. Installed hooks call this automatically.
    #[command(hide = true)]
    ValidateReceive,
}

fn run() -> Result<()> {
    let args = Args::parse();
    match args.command {
        Command::Init {
            owner,
            public_url,
            max_snapshot_mib,
            max_upload_mib,
        } => {
            let state = state::State::initialize(
                &args.data,
                owner,
                public_url,
                max_snapshot_mib,
                max_upload_mib,
            )?;
            println!("{}", state.issue_token("initial")?);
        }
        command => {
            let mut state = state::State::open(&args.data)?;
            match command {
                Command::Serve { listen } => http::serve(&mut state, &listen)?,
                Command::IssueToken { label } => println!("{}", state.issue_token(&label)?),
                Command::ListTokens => println!("{}", state.list_tokens()?),
                Command::RevokeToken { id } => state.revoke_token(&id)?,
                Command::Reindex => {
                    let _lock = state.exclusive_lock()?;
                    state.db.execute_batch(
                        "BEGIN IMMEDIATE;
                        UPDATE repositories SET dirty=1;
                        DELETE FROM snapshot_events; DELETE FROM snapshots; DELETE FROM saved_refs;
                        DELETE FROM event_search; DELETE FROM events; COMMIT;",
                    )?;
                    let mut failed = false;
                    for repo in state.repositories()? {
                        if let Err(error) = index::reindex(&mut state, &repo) {
                            failed = true;
                            eprintln!("Repository {}/{}: {error:#}", repo.owner, repo.name);
                        }
                    }
                    anyhow::ensure!(
                        !failed,
                        "Rebuild completed with incomplete indexes; inspect the diagnostics"
                    );
                    println!("Search index rebuilt");
                }
                Command::ValidateReceive => {
                    let repo = std::env::current_dir().context("No Git working directory")?;
                    git::validate_receive(&state, &repo)?;
                }
                Command::Init { .. } => unreachable!(),
            }
        }
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("agit-selfhost: {error:#}");
        std::process::exit(1);
    }
}
