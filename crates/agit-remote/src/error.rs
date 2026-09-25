//! Error bodies use the Hub's `{"error","kind"}` shape; clients read only `error`.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    /// Clients treat 503 as transient and retry, so it marks conditions that can clear by themselves.
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }
}

impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        eprintln!("agit-remote: request failed: {error:#}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal relay error; see server diagnostics",
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let kind = match self.status.as_u16() {
            400 => "invalid_request",
            401 => "unauthorized",
            403 => "forbidden",
            404 => "not_found",
            503 => "unavailable",
            _ => "request_failed",
        };
        (
            self.status,
            Json(serde_json::json!({"error": self.message, "kind": kind})),
        )
            .into_response()
    }
}
