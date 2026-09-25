//! Cloud peer relay and Web console for a private AgentGit Hub.
//!
//! The Hub itself serves requests one at a time, which cannot hold long-lived sockets; this
//! service answers `/api/peer/*` and `/console/*` beside it on its own loopback port, behind
//! the same HTTPS origin, and asks the Hub which account a token belongs to.

mod auth;
mod console;
mod error;
mod proxy;
mod registry;
mod relay;
mod util;

use clap::{Args, Parser, Subcommand};
use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the relay and console on a loopback address behind the Hub's HTTPS reverse proxy.
    Serve(ServeArgs),
}

#[derive(Args)]
struct ServeArgs {
    /// Directory for the device registry and console sessions.
    #[arg(long)]
    data: PathBuf,
    #[arg(long, default_value = "127.0.0.1:8178")]
    listen: SocketAddr,
    /// The Hub's public origin exactly as clients are configured with it; it is the issuer
    /// of every device and grant.
    #[arg(long)]
    public_url: String,
    /// The Hub's own loopback address, used to resolve account tokens.
    #[arg(long, default_value = "http://127.0.0.1:8177")]
    upstream: String,
    /// Forward every other route to the Hub. Local testing only.
    #[arg(long)]
    dev_proxy: bool,
    /// Local testing only: offer a console sign-in that uses the PAT in this file, so a
    /// browser under test never handles the token. Refused for any non-loopback origin.
    #[arg(long)]
    dev_login_pat_file: Option<PathBuf>,
}

pub struct App {
    pub issuer: String,
    pub accounts: auth::Accounts,
    pub registry: registry::Registry,
    pub relay: relay::state::Relay,
    pub console: console::Console,
    pub upstream: String,
    pub dev_proxy: Option<reqwest::Client>,
}

fn main() -> anyhow::Result<()> {
    // The console's controller runs each connection in a worker process: this executable
    // started with the single argument `tunnel`.
    if std::env::args().nth(1).as_deref() == Some("tunnel") {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        return runtime.block_on(agit_tunnel::worker::run(
            tokio::io::BufReader::new(tokio::io::stdin()),
            tokio::io::stdout(),
        ));
    }
    let cli = Cli::parse();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    match cli.command {
        Command::Serve(args) => runtime.block_on(serve(args)),
    }
}

async fn serve(args: ServeArgs) -> anyhow::Result<()> {
    let issuer = util::normalize_origin(&args.public_url)?;
    let dev_pat = match &args.dev_login_pat_file {
        None => None,
        Some(path) => {
            let host = url::Url::parse(&issuer)?
                .host_str()
                .unwrap_or_default()
                .to_owned();
            anyhow::ensure!(
                issuer.starts_with("http://") && (host == "127.0.0.1" || host == "localhost"),
                "--dev-login-pat-file is only accepted for a loopback http public URL"
            );
            Some(std::fs::read_to_string(path)?.trim().to_owned())
        }
    };
    let upstream = args.upstream.trim_end_matches('/').to_owned();
    std::fs::create_dir_all(&args.data)?;
    // The console's controller reaches this relay directly; the public origin stays the issuer.
    let mut loopback = args.listen;
    if loopback.ip().is_unspecified() {
        loopback.set_ip(Ipv4Addr::LOCALHOST.into());
    }
    let app = Arc::new(App {
        accounts: auth::Accounts::new(issuer.clone(), upstream.clone())?,
        registry: registry::Registry::open(args.data.join("devices.json"), issuer.clone())?,
        relay: relay::state::Relay::default(),
        console: console::Console::open(
            &args.data,
            &issuer,
            format!("http://{loopback}"),
            dev_pat,
        )?,
        issuer: issuer.clone(),
        upstream,
        dev_proxy: args
            .dev_proxy
            .then(|| reqwest::Client::builder().no_proxy().build())
            .transpose()?,
    });
    let sweeper = app.clone();
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(Duration::from_secs(10));
        loop {
            ticks.tick().await;
            sweeper.relay.sweep();
            sweeper.registry.sweep();
            sweeper.console.sweep();
        }
    });
    let router = relay::routes()
        .merge(console::routes())
        .fallback(proxy::forward)
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    eprintln!(
        "agit-remote listening on {} for {issuer}",
        listener.local_addr()?
    );
    // No graceful drain: open links cannot finish on their own, and endpoints reconnect.
    axum::serve(listener, router).await?;
    Ok(())
}
