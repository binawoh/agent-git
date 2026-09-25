//! The console's single-page application, embedded at build time from `web/dist`.
//! Hashed assets are cached forever; every other path serves `index.html`.

use axum::{
    body::Body,
    http::{HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Redirect, Response},
};

#[derive(rust_embed::Embed)]
#[folder = "web/dist"]
#[allow_missing = true]
struct Assets;

pub async fn redirect() -> Redirect {
    Redirect::permanent("/console/")
}

pub fn content_security_policy(issuer: &str) -> HeaderValue {
    let socket = issuer.replacen("http", "ws", 1);
    HeaderValue::from_str(&format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' {socket}; \
         frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
    ))
    .expect("the issuer is a validated origin")
}

pub fn serve(uri: &Uri, policy: HeaderValue) -> Response {
    let path = uri.path().trim_start_matches("/console/");
    let (path, immutable) = match Assets::get(path) {
        Some(_) if !path.is_empty() => (path, path.starts_with("assets/")),
        _ if path.starts_with("assets/") => return StatusCode::NOT_FOUND.into_response(),
        _ => ("index.html", false),
    };
    let Some(file) = Assets::get(path) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "The console was built without its web assets; run `npm run build` in crates/agit-remote/web.",
        )
            .into_response();
    };
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut response = Response::new(Body::from(file.data.into_owned()));
    let headers = response.headers_mut();
    if let Ok(mime) = HeaderValue::from_str(file.metadata.mimetype()) {
        headers.insert(header::CONTENT_TYPE, mime);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(header::CONTENT_SECURITY_POLICY, policy);
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}
