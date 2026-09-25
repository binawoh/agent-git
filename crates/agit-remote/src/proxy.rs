//! Development-only passthrough for the Hub's own routes, so a local test can use one origin
//! for sign-in and the relay. Production routing belongs to the HTTPS reverse proxy.

use crate::App;
use axum::{
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderName, StatusCode, header},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

const MAX_BODY: usize = 64 * 1024 * 1024;
const FORWARDED: [HeaderName; 3] = [header::AUTHORIZATION, header::CONTENT_TYPE, header::ACCEPT];

pub async fn forward(State(app): State<Arc<App>>, request: Request) -> Response {
    let Some(http) = app.dev_proxy.as_ref() else {
        return crate::error::ApiError::not_found("Unsupported operation").into_response();
    };
    let path = request
        .uri()
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .to_owned();
    let method = request.method().clone();
    let mut outgoing = http.request(method, format!("{}{path}", app.upstream));
    for name in FORWARDED {
        if let Some(value) = request.headers().get(&name) {
            outgoing = outgoing.header(name, value);
        }
    }
    for (name, value) in request.headers() {
        if name.as_str().starts_with("x-agentgit-") {
            outgoing = outgoing.header(name, value);
        }
    }
    let Ok(body) = to_bytes(request.into_body(), MAX_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let upstream = match outgoing.body(body).send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("agit-remote: development proxy failed: {error}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let mut response = Response::builder().status(upstream.status().as_u16());
    if let Some(content_type) = upstream.headers().get(header::CONTENT_TYPE) {
        response = response.header(header::CONTENT_TYPE, content_type.as_bytes());
    }
    match upstream.bytes().await {
        Ok(bytes) => response
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response()),
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}
