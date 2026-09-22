use crate::{
    git,
    state::{Repository, State, digest, timestamp},
};
use agit::{
    adapter::EventKind,
    domain::{
        query::{EventScope, Query},
        storage, transcript, turn,
    },
};
use anyhow::{Context, Result, ensure};
use rusqlite::params;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};

fn scope(kind: EventKind) -> Option<EventScope> {
    match kind {
        EventKind::UserPrompt | EventKind::UserInterjection => Some(EventScope::Prompt),
        EventKind::AssistantReply => Some(EventScope::Reply),
        EventKind::ToolUse => Some(EventScope::Tool),
        EventKind::ToolResult => Some(EventScope::Output),
        EventKind::FileEdit => Some(EventScope::Edit),
        EventKind::CompactFiltered | EventKind::CompactSummary => Some(EventScope::Summary),
        _ => None,
    }
}

pub fn reindex(state: &mut State, repo: &Repository) -> Result<()> {
    state
        .db
        .execute("UPDATE repositories SET dirty=1 WHERE id=?1", [&repo.id])?;
    let path = state.repo_path(repo);
    let refs = git::output(
        &path,
        &[
            "for-each-ref",
            "--format=%(refname) %(objectname)",
            "refs/heads",
            "refs/tags",
        ],
    )?;
    let mut published = Vec::new();
    for line in refs.lines() {
        let (name, oid) = line.split_once(' ').context("Invalid Git ref listing")?;
        published.push((name.to_owned(), oid.to_owned()));
    }
    let history = git::output(&path, &["rev-list", "--all", "--max-count=100001"])?;
    ensure!(
        history.lines().count() <= 100000,
        "History exceeds the indexing limit"
    );
    let mut failed = false;
    for oid in history.lines() {
        let result = (|| -> Result<()> {
            let exists: bool = state.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM snapshots WHERE repo_id=?1 AND oid=?2)",
                params![repo.id, oid],
                |r| r.get(0),
            )?;
            if exists {
                return Ok(());
            }
            let metadata = git::snapshot_meta(&path, oid)?;
            if metadata.is_file_line() || metadata.session.is_empty() {
                return Ok(());
            }
            let (log, _) = storage::materialize_pair_bounded(
                &path,
                oid,
                state.config.max_snapshot_mib * 1024 * 1024,
            )?;
            let raw = transcript::unwrap_strict(&log)?;
            let session = transcript::display::parse(&log)?;
            let groups = turn::groups_of(&session);
            let mut ordinals = HashMap::new();
            for (index, events) in groups.iter().enumerate() {
                for event in events {
                    ordinals.insert(*event, index + 1);
                }
            }
            let saved = git::output(&path, &["show", "-s", "--format=%ct%n%an%n%ae", oid])?;
            let mut saved = saved.lines();
            let saved_at: i64 = saved.next().context("Missing saved time")?.parse()?;
            ensure!(
                chrono::DateTime::from_timestamp(saved_at, 0).is_some(),
                "Saved timestamp is outside the supported range"
            );
            let author = saved.next().unwrap_or("");
            let email = saved.next().unwrap_or("");
            let lines: Vec<_> = raw.lines().collect();
            let origin = metadata
                .cwd_state
                .as_ref()
                .and_then(|s| s.origin.as_deref());
            let tx = state.db.transaction()?;
            tx.execute(
            "INSERT INTO snapshots(repo_id,oid,session,runtime,saved,author,email,origin,turns) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                repo.id,
                oid,
                metadata.session,
                metadata.runtime,
                saved_at,
                author,
                email,
                origin,
                groups.len()
            ],
        )?;
            let mut complete = true;
            for (ordinal, event) in session.events.iter().enumerate() {
                let Some(scope) = scope(event.kind) else {
                    continue;
                };
                let raw_line = event
                    .line
                    .and_then(|line| lines.get(line))
                    .copied()
                    .unwrap_or("");
                let mut text = format!("{}\n{raw_line}", event.text.as_deref().unwrap_or(""));
                let event_key = digest(serde_json::to_vec(&json!([
                    scope.as_str(),
                    text,
                    event.tool,
                    event.paths
                ]))?);
                if text.len() > 1024 * 1024 {
                    complete = false;
                    let mut end = 1024 * 1024;
                    while !text.is_char_boundary(end) {
                        end -= 1;
                    }
                    text.truncate(end);
                }
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO events VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        event_key,
                        scope.as_str(),
                        text,
                        text.to_lowercase(),
                        event.tool,
                        serde_json::to_string(&event.paths)?,
                        scope.is_secondhand()
                    ],
                )?;
                if inserted > 0 {
                    tx.execute(
                        "INSERT INTO event_search(id,text) VALUES (?1,?2)",
                        params![event_key, text.to_lowercase()],
                    )?;
                }
                tx.execute(
                    "INSERT INTO snapshot_events VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        repo.id,
                        oid,
                        ordinal,
                        event_key,
                        event.line.map(|n| n + 1).unwrap_or(0),
                        ordinals.get(&ordinal).copied().unwrap_or(0)
                    ],
                )?;
            }
            tx.execute(
                "UPDATE snapshots SET index_complete=?1 WHERE repo_id=?2 AND oid=?3",
                params![complete, repo.id, oid],
            )?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = result {
            failed = true;
            eprintln!("Snapshot {} {oid} is not fully indexed: {error:#}", repo.id);
        }
    }
    let tx = state.db.transaction()?;
    tx.execute("DELETE FROM saved_refs WHERE repo_id=?1", [&repo.id])?;
    for (name, oid) in published {
        tx.execute(
            "INSERT INTO saved_refs VALUES (?1,?2,?3)",
            params![repo.id, name, oid],
        )?;
    }
    let partial: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM snapshots WHERE repo_id=?1 AND index_complete=0)",
        [&repo.id],
        |row| row.get(0),
    )?;
    tx.execute(
        "UPDATE repositories SET dirty=?1 WHERE id=?2",
        params![failed || partial, repo.id],
    )?;
    tx.commit()?;
    ensure!(
        !failed && !partial,
        "Search index remains incomplete; valid history is searchable and original Git data is retained"
    );
    Ok(())
}

fn time_filter(value: Option<&String>) -> Result<Option<i64>> {
    value
        .map(|value| {
            chrono::DateTime::parse_from_rfc3339(value)
                .map(|v| v.timestamp())
                .context("Time filters must be RFC3339 timestamps")
        })
        .transpose()
}

pub fn search(state: &State, params: &BTreeMap<String, String>) -> Result<Value> {
    let query = Query::parse(params.get("q").map(String::as_str).unwrap_or(""));
    ensure!(
        query.category.is_none() && query.state.is_none() && query.fork.is_none(),
        "Unsupported category, state or fork filter"
    );
    ensure!(
        !params.contains_key("scope"),
        "Organization scope is unsupported"
    );
    let page: usize = params
        .get("page")
        .map(String::as_str)
        .unwrap_or("1")
        .parse()?;
    let per: usize = params
        .get("per")
        .map(String::as_str)
        .unwrap_or("10")
        .parse()?;
    ensure!(
        (1..=100000).contains(&page) && (1..=100).contains(&per),
        "Invalid pagination"
    );
    let sort = params.get("sort").map(String::as_str).unwrap_or("best");
    ensure!(
        ["best", "recent", "turns"].contains(&sort),
        "Unsupported sort"
    );
    let since = time_filter(params.get("since"))?;
    let before = time_filter(params.get("before"))?;
    let filters: BTreeMap<_, _> = ["author", "since", "before", "code_origin"]
        .into_iter()
        .filter_map(|key| params.get(key).map(|value| (key, value)))
        .collect();
    let dirty: bool = state.db.query_row(
        "SELECT EXISTS(SELECT 1 FROM repositories WHERE dirty=1)",
        [],
        |r| r.get(0),
    )?;
    // Trigrams narrow long terms; shorter substrings retain a complete fallback scan.
    let fts = query
        .terms
        .iter()
        .filter(|term| term.chars().count() >= 3)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ");
    let candidate = if fts.is_empty() {
        String::new()
    } else {
        " AND e.id IN (SELECT id FROM event_search WHERE event_search MATCH ?1)".to_owned()
    };
    let sql = format!(
        "SELECT r.owner,r.name,s.session,s.runtime,s.oid,s.saved,s.author,s.email,s.origin,s.turns,e.scope,e.text,e.tool,e.paths,e.secondhand,se.line,se.turn FROM snapshots s JOIN repositories r ON r.id=s.repo_id JOIN snapshot_events se ON se.repo_id=s.repo_id AND se.oid=s.oid JOIN events e ON e.id=se.event_id WHERE 1=1{candidate} ORDER BY s.saved DESC,s.oid,se.ordinal LIMIT 50001"
    );
    let mut statement = state.db.prepare(&sql)?;
    let mut rows = if fts.is_empty() {
        statement.query([])?
    } else {
        statement.query([fts])?
    };
    let mut hits = HashMap::<String, Value>::new();
    let mut examined = 0;
    let mut incomplete = dirty;
    while let Some(row) = rows.next()? {
        examined += 1;
        if examined > 50000 {
            incomplete = true;
            break;
        }
        let owner: String = row.get(0)?;
        let name: String = row.get(1)?;
        let session: String = row.get(2)?;
        let runtime: String = row.get(3)?;
        let oid: String = row.get(4)?;
        let saved: i64 = row.get(5)?;
        let author: String = row.get(6)?;
        let email: String = row.get(7)?;
        let origin: Option<String> = row.get(8)?;
        let turns: usize = row.get(9)?;
        let scope_name: String = row.get(10)?;
        let text: String = row.get(11)?;
        let tool: Option<String> = row.get(12)?;
        let paths: Vec<String> = serde_json::from_str(&row.get::<_, String>(13)?)?;
        let secondhand: bool = row.get(14)?;
        let line: usize = row.get(15)?;
        let turn: usize = row.get(16)?;
        let slug = format!("{owner}/{name}");
        if query.owner.as_ref().is_some_and(|q| q != &owner)
            || query
                .agent
                .as_ref()
                .is_some_and(|q| q != &slug && q != &name)
            || query.runtime.as_ref().is_some_and(|q| q != &runtime)
            || query.visibility.as_deref().is_some_and(|v| v != "private")
            || query
                .tool
                .as_ref()
                .is_some_and(|q| tool.as_deref().is_none_or(|v| !v.eq_ignore_ascii_case(q)))
            || query.path.as_ref().is_some_and(|q| {
                !paths
                    .iter()
                    .any(|path| path.to_lowercase().contains(&q.to_lowercase()))
            })
            || query.turns.is_some_and(|q| !q.matches(turns))
            || !query.allows(EventScope::parse(&scope_name).unwrap())
            || !query.matches_text(&text)
            || since.is_some_and(|q| saved < q)
            || before.is_some_and(|q| saved >= q)
            || params
                .get("author")
                .is_some_and(|q| !author.eq_ignore_ascii_case(q) && !email.eq_ignore_ascii_case(q))
            || params
                .get("code_origin")
                .is_some_and(|q| origin.as_ref() != Some(q))
        {
            continue;
        }
        let key = format!("{slug}/{session}");
        if let Some(hit) = hits.get_mut(&key) {
            let count = hit["other_hits"].as_u64().unwrap_or(0);
            hit["other_hits"] = json!(count + 1);
            continue;
        }
        let excerpt = text.chars().take(800).collect::<String>();
        let url = format!(
            "{}/api/agents/{}/{}/sessions/{}?ref={}&from={}&to={}&detail=inline",
            state.config.public_url,
            owner,
            name,
            session,
            oid,
            turn.max(1),
            turn.max(1) + 1
        );
        hits.insert(key,json!({"agent":slug,"session_id":session,"excerpt":excerpt,"url":url,"runtime":runtime,"scope":scope_name,"secondhand":secondhand,"tool":tool,"paths":paths,"turns":turns,"timestamp":timestamp(saved),"line":line,"other_hits":0,"outcome":"unknown","commit":oid,"turn":turn}));
    }
    let mut hits: Vec<_> = hits.into_values().collect();
    hits.sort_by(|a, b| {
        if sort == "turns" {
            b["turns"].as_u64().cmp(&a["turns"].as_u64())
        } else if sort == "best" {
            a["secondhand"].as_bool().cmp(&b["secondhand"].as_bool())
        } else {
            std::cmp::Ordering::Equal
        }
        .then_with(|| b["timestamp"].as_str().cmp(&a["timestamp"].as_str()))
        .then_with(|| a["session_id"].as_str().cmp(&b["session_id"].as_str()))
    });
    let total = hits.len();
    let items: Vec<_> = hits.into_iter().skip((page - 1) * per).take(per).collect();
    Ok(
        json!({"type":"sessions","applied_filters":filters,"total":total,"page":page,"per":per,"items":items,"incomplete":incomplete,"unknown":query.unknown,"terms":query.terms}),
    )
}

pub fn read_remote(
    state: &State,
    repo: &Repository,
    session_id: &str,
    params: &BTreeMap<String, String>,
) -> Result<Value> {
    let reference = params.get("ref").context("A saved reference is required")?;
    let from: usize = params
        .get("from")
        .map(String::as_str)
        .unwrap_or("1")
        .parse()?;
    let to: usize = match params.get("to") {
        Some(value) => value.parse()?,
        None => from.checked_add(10).context("Turn range overflow")?,
    };
    ensure!(
        from > 0 && to > from && to - from <= 50,
        "Request between 1 and 50 turns, using an exclusive to bound"
    );
    let path = state.repo_path(repo);
    let oid = git::resolve(&path, reference)?;
    let metadata = git::snapshot_meta(&path, &oid)?;
    ensure!(
        metadata.session == session_id,
        "Session does not match saved reference"
    );
    let (log, _) = storage::materialize_pair_bounded(
        &path,
        &oid,
        state.config.max_snapshot_mib * 1024 * 1024,
    )?;
    let session = transcript::display::parse(&log)?;
    let groups = turn::groups_of(&session);
    let envelopes = storage::parse_envelopes(&log)?;
    let mut selected = Vec::new();
    let mut bytes = 0;
    let mut next = None;
    let mut starts = groups
        .iter()
        .map(|group| {
            group
                .iter()
                .filter_map(|ordinal| session.events[*ordinal].line)
                .min()
                .context("Turn has no source line")
        })
        .collect::<Result<Vec<_>>>()?;
    if let Some(first) = starts.first_mut() {
        *first = 0;
    }
    starts.push(envelopes.len());
    ensure!(
        starts.windows(2).all(|pair| pair[0] <= pair[1]),
        "Turn source lines are not ordered"
    );
    for index in (from - 1..groups.len()).take(to - from) {
        let events = (starts[index]..starts[index + 1])
            .map(|line| {
                let envelope=&envelopes[line];
                Ok(json!({"line":line+1,"source":envelope.source,"source_session_id":envelope.session_id,"content":envelope.content}))
            })
            .collect::<Result<Vec<_>>>()?;
        let item = json!({"turn":index+1,"events":events});
        let size = serde_json::to_vec(&item)?.len();
        ensure!(
            size <= 4 * 1024 * 1024,
            "A turn exceeds the remote read limit; clone this snapshot for full restoration"
        );
        if bytes + size > 4 * 1024 * 1024 {
            next = Some(index + 1);
            break;
        }
        bytes += size;
        selected.push(item);
    }
    if next.is_none() && to <= groups.len() {
        next = Some(to);
    }
    Ok(
        json!({"schema":"agit-selfhost-transcript","schema_version":1,"agent":format!("{}/{}",repo.owner,repo.name),"session_id":session_id,"runtime":metadata.runtime,"commit":oid,"from":from,"to":to,"total_turns":groups.len(),"turns":selected,"next_from":next,"truncated":next.is_some()}),
    )
}
