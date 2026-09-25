//! The cloud peer API under `/api/peer`: device enrollment and discovery, connection admission,
//! and the presence and data sockets. The relay mints grants but never interprets session traffic.

mod socket;
pub mod state;

use crate::{
    App,
    error::{ApiError, ApiResult},
    registry::{CONTROLLER_LEASE, Kind},
    util::bearer,
};
use agit_peer::cloud::{
    ConnectionGrant, Device, DeviceCredential, DevicePage, DevicePresence, DialedConnection,
    Enrollment,
};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{delete, get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

pub fn routes() -> Router<Arc<App>> {
    Router::new()
        .route("/api/peer/devices", post(enroll).get(devices))
        .route("/api/peer/devices/{id}", delete(revoke))
        .route("/api/peer/controllers", post(register_controller))
        .route("/api/peer/controllers/me", put(renew_controller))
        .route("/api/peer/connections", post(connect))
        .route("/api/peer/grants/verify", post(verify))
        .route("/api/peer/grants/renew", post(renew))
        .route("/api/peer/presence", get(socket::presence))
        .route("/api/peer/data", get(socket::data))
}

fn device_token(app: &App, headers: &HeaderMap, kind: Kind) -> ApiResult<Device> {
    bearer(headers)
        .and_then(|token| app.registry.authenticate(token))
        .filter(|authenticated| authenticated.kind == kind)
        .map(|authenticated| authenticated.device)
        .ok_or_else(|| ApiError::unauthorized("Invalid device credential"))
}

async fn enroll(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(enrollment): Json<Enrollment>,
) -> ApiResult<Json<DeviceCredential>> {
    let owner = app.accounts.principal(&headers).await?;
    let credential = app
        .registry
        .enroll(&owner, enrollment, Kind::Device, None)?;
    // Re-enrollment invalidates grants and presence that were bound to the previous credential.
    app.relay.forget_device(&credential.device.id);
    Ok(Json(credential))
}

#[derive(Deserialize)]
struct PageQuery {
    after: Option<String>,
}

async fn devices(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Query(query): Query<PageQuery>,
) -> ApiResult<Json<DevicePage>> {
    let owner = app.accounts.principal(&headers).await?;
    let (devices, next_cursor) = app.registry.page(&owner, query.after.as_deref());
    Ok(Json(DevicePage {
        devices: devices
            .into_iter()
            .map(|device| DevicePresence {
                online: app.relay.online(&device.id),
                device,
            })
            .collect(),
        next_cursor,
    }))
}

async fn revoke(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let owner = app.accounts.principal(&headers).await?;
    if !app.registry.revoke(&owner, &id)? {
        return Err(ApiError::not_found("no such device"));
    }
    app.relay.forget_device(&id);
    Ok(Json(json!({"ok": true})))
}

async fn register_controller(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(enrollment): Json<Enrollment>,
) -> ApiResult<Json<DeviceCredential>> {
    let owner = app.accounts.principal(&headers).await?;
    Ok(Json(app.registry.enroll(
        &owner,
        enrollment,
        Kind::Controller,
        Some(CONTROLLER_LEASE),
    )?))
}

async fn renew_controller(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let controller = device_token(&app, &headers, Kind::Controller)?;
    if !app.registry.renew(&controller.id) {
        return Err(ApiError::unauthorized("the controller lease has expired"));
    }
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
struct Connect {
    source_device_id: String,
    target_device_id: String,
}

async fn connect(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<Connect>,
) -> ApiResult<Json<DialedConnection>> {
    let caller = app.accounts.principal(&headers).await?;
    let (source, _) = app
        .registry
        .owned(&caller, &request.source_device_id)
        .ok_or_else(|| ApiError::forbidden("the source device does not belong to this account"))?;
    let (target, kind) = app
        .registry
        .owned(&caller, &request.target_device_id)
        .ok_or_else(|| ApiError::forbidden("this account is not allowed to access the device"))?;
    if kind != Kind::Device {
        return Err(ApiError::bad_request(
            "controllers cannot be connection targets",
        ));
    }
    Ok(Json(app.relay.dial(caller, source, target)?))
}

#[derive(Deserialize)]
struct GrantToken {
    token: String,
}

async fn verify(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<GrantToken>,
) -> ApiResult<Json<ConnectionGrant>> {
    let executor = device_token(&app, &headers, Kind::Device)?;
    app.relay
        .grant_for(&executor, &request.token)
        .map(Json)
        .ok_or_else(|| ApiError::forbidden("the connection grant is no longer valid"))
}

async fn renew(
    State(app): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<GrantToken>,
) -> ApiResult<Json<ConnectionGrant>> {
    let executor = device_token(&app, &headers, Kind::Device)?;
    Ok(Json(app.relay.renew(
        &executor,
        &request.token,
        &app.registry,
    )?))
}
