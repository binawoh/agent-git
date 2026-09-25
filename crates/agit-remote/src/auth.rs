//! Account tokens are the Hub's own access tokens; the relay asks the Hub whose they are.
//! The in-process Web controller authenticates with an internal token that never leaves
//! this process except over its own loopback connection.

use crate::{
    error::{ApiError, ApiResult},
    util::{bearer, digest},
};
use agit_peer::access::Principal;
use axum::http::{HeaderMap, StatusCode};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

/// A revoked Hub session keeps working here for at most this long.
const CACHE_TTL: Duration = Duration::from_secs(60);
const CACHE_LIMIT: usize = 1024;

pub struct Accounts {
    issuer: String,
    upstream: String,
    http: reqwest::Client,
    cache: Mutex<HashMap<String, (String, Instant)>>,
    internal: Mutex<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct Me {
    account_id: String,
}

/// A Hub sign-in; the access token is not kept because nothing here calls the Hub as the user.
#[derive(Deserialize)]
pub struct SignIn {
    pub account_id: String,
    pub username: String,
    pub refresh_token: String,
}

pub enum Refresh {
    Renewed(String),
    Rejected,
    Unavailable,
}

impl Accounts {
    pub fn new(issuer: String, upstream: String) -> anyhow::Result<Self> {
        Ok(Self {
            issuer,
            upstream: upstream.trim_end_matches('/').to_owned(),
            // The Hub is a loopback neighbour; an environment proxy must not intercept it.
            http: reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(10))
                .build()?,
            cache: Mutex::default(),
            internal: Mutex::default(),
        })
    }

    pub fn principal_of(&self, account_id: &str) -> Principal {
        Principal {
            issuer: self.issuer.clone(),
            account_id: account_id.to_owned(),
        }
    }

    pub fn register_internal(&self, token: &str, account_id: &str) {
        self.internal
            .lock()
            .unwrap()
            .insert(digest(token), account_id.to_owned());
    }

    pub async fn principal(&self, headers: &HeaderMap) -> ApiResult<Principal> {
        let token = bearer(headers)
            .ok_or_else(|| ApiError::unauthorized("Bearer authentication required"))?;
        let key = digest(token);
        if let Some(account) = self.internal.lock().unwrap().get(&key) {
            return Ok(self.principal_of(account));
        }
        if let Some((account, verified)) = self.cache.lock().unwrap().get(&key)
            && verified.elapsed() < CACHE_TTL
        {
            return Ok(self.principal_of(account));
        }
        let response = self
            .http
            .get(format!("{}/api/auth/me", self.upstream))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|error| {
                eprintln!("agit-remote: Hub account lookup failed: {error}");
                ApiError::unavailable("the Hub account service is unavailable")
            })?;
        match response.status() {
            status if status.is_success() => {
                let me: Me = response
                    .json()
                    .await
                    .map_err(|_| ApiError::unavailable("the Hub returned an invalid account"))?;
                let mut cache = self.cache.lock().unwrap();
                if cache.len() >= CACHE_LIMIT {
                    cache.retain(|_, (_, verified)| verified.elapsed() < CACHE_TTL);
                }
                cache.insert(key, (me.account_id.clone(), Instant::now()));
                Ok(self.principal_of(&me.account_id))
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err(ApiError::unauthorized("Invalid or expired access token"))
            }
            status => {
                eprintln!("agit-remote: Hub account lookup returned HTTP {status}");
                Err(ApiError::unavailable(
                    "the Hub account service is unavailable",
                ))
            }
        }
    }

    /// Exchanges a personal access token at the Hub, the same way `agit login --with-token` does.
    pub async fn sign_in(&self, pat: &str) -> ApiResult<SignIn> {
        let response = self
            .http
            .post(format!("{}/api/auth/login", self.upstream))
            .json(&json!({"token": pat}))
            .send()
            .await
            .map_err(|_| ApiError::unavailable("the Hub account service is unavailable"))?;
        match response.status() {
            status if status.is_success() => response
                .json()
                .await
                .map_err(|_| ApiError::unavailable("the Hub returned an invalid sign-in")),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::BAD_REQUEST => Err(
                ApiError::unauthorized("the access token is invalid or revoked"),
            ),
            _ => Err(ApiError::unavailable(
                "the Hub account service is unavailable",
            )),
        }
    }

    /// Refresh tokens rotate; a rejected one means the PAT behind it was revoked or expired.
    pub async fn refresh(&self, refresh_token: &str) -> Refresh {
        let response = self
            .http
            .post(format!("{}/api/auth/refresh", self.upstream))
            .json(&json!({"refresh_token": refresh_token}))
            .send()
            .await;
        let Ok(response) = response else {
            return Refresh::Unavailable;
        };
        match response.status() {
            status if status.is_success() => match response.json::<SignIn>().await {
                Ok(renewed) => Refresh::Renewed(renewed.refresh_token),
                Err(_) => Refresh::Unavailable,
            },
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Refresh::Rejected,
            _ => Refresh::Unavailable,
        }
    }
}
