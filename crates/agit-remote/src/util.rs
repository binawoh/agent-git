//! Bearer secrets are random and the relay keeps only their digests.

use axum::http::{HeaderMap, header::AUTHORIZATION};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn secret(prefix: &str) -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("operating system randomness is unavailable");
    format!("{prefix}_{}", hex::encode(bytes))
}

pub fn digest(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

pub fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
}

/// Clients compare issuers byte for byte against `Url::parse(origin).as_str()` without its
/// trailing slash, so the relay must derive the issuer the same way and never from `Host`.
pub fn normalize_origin(origin: &str) -> anyhow::Result<String> {
    let url = url::Url::parse(origin)?;
    anyhow::ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "the public URL must be a bare origin such as https://hub.example"
    );
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    #[test]
    fn issuer_matches_the_client_normalization() {
        assert_eq!(
            super::normalize_origin("https://Hub.Example/").unwrap(),
            "https://hub.example"
        );
        assert!(super::normalize_origin("https://hub.example/path").is_err());
    }
}
