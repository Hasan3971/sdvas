"""REST API (v1), BAS-friendly aliases and the legacy /code endpoint."""
from __future__ import annotations

import json
import time

from . import __version__, parsing
from .auth import PRESETS, SCOPES
from .hub import SETTING_DEFAULTS, ApiError
from .util import parse_ts, to_int, truthy
from .web import COOKIE, Response, router


def actor(req) -> str:
    return "admin" if req.identity.kind == "session" else f"key:{req.identity.name}"


def list_param(value) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    return [p.strip() for p in str(value).replace("\n", ",").split(",") if p.strip()]


def filters_from(src: dict) -> dict:
    return {"q": str(src.get("q", "") or ""), "status": str(src.get("status", "") or ""),
            "type_": str(src.get("type", "") or ""), "tag": str(src.get("tag", "") or ""),
            "health": str(src.get("health", "") or "")}


def session_cookie(value: str, max_age: int, secure: bool) -> str:
    return f"{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}" + ("; Secure" if secure else "")


# ---------------------------------------------------------------- service + auth
@router.route("GET", "/api/v1/health")
@router.route("GET", "/api/health")
@router.route("GET", "/health")
def health(hub, req):
    return {"ok": True, "version": __version__}


@router.route("POST", "/api/v1/auth/login")
def login(hub, req):
    wait = hub.auth.limiter.retry_after(req.ip)
    if wait:
        raise ApiError(429, "too_many_attempts", f"забагато спроб входу; повторіть через {wait} с", retry_after=wait)
    if not hub.auth.check_password(str(req.data().get("password") or "")):
        hub.auth.limiter.fail(req.ip)
        hub.event("auth.failed", req.ip)
        time.sleep(0.5)
        raise ApiError(401, "bad_password", "невірний пароль")
    hub.auth.limiter.reset(req.ip)
    token, csrf, ttl = hub.auth.make_session()
    response = Response.json({"ok": True, "csrf": csrf, "scopes": list(SCOPES)})
    response.cookies.append(session_cookie(token, ttl, req.secure))
    hub.event("auth.login", req.ip, actor="admin")
    return response


@router.route("POST", "/api/v1/auth/logout")
def logout(hub, req):
    response = Response.json({"ok": True})
    response.cookies.append(session_cookie("", 0, req.secure))
    return response


@router.route("GET", "/api/v1/me", "auth")
def me(hub, req):
    who = req.identity
    return {"kind": who.kind, "name": who.name, "scopes": sorted(who.scopes), "csrf": who.csrf,
            "version": __version__, "public_url": hub.config.public_url}


@router.route("POST", "/api/v1/auth/password", "admin")
def change_password(hub, req):
    d = req.data()
    if not hub.auth.check_password(str(d.get("current") or "")):
        raise ApiError(403, "bad_password", "поточний пароль невірний")
    try:
        hub.auth.set_password(str(d.get("new") or ""))
    except ValueError as exc:
        raise ApiError(400, "weak_password", str(exc)) from exc
    hub.event("auth.password", actor=actor(req))
    token, csrf, ttl = hub.auth.make_session()
    response = Response.json({"ok": True, "csrf": csrf})
    response.cookies.append(session_cookie(token, ttl, req.secure))
    return response


@router.route("GET", "/api/v1/stats", "read")
def stats(hub, req):
    return hub.stats()


@router.route("GET", "/api/v1/events", "read")
def events(hub, req):
    d = req.data()
    return {"items": hub.events(to_int(d.get("limit"), 100, 1, 500), to_int(d.get("before"), 0) or None, str(d.get("kind", "")))}


# ---------------------------------------------------------------- mailboxes
def want_secrets(req, default: bool = False) -> bool:
    flag = truthy(req.data().get("secrets"), default)
    if flag:
        req.require("secrets")
    return flag


@router.route("GET", "/api/v1/mailboxes", "read")
def mailboxes_list(hub, req):
    d = req.data()
    return hub.list_mailboxes(sort=str(d.get("sort", "updated_at")), order=str(d.get("order", "desc")),
                              limit=d.get("limit", 50), offset=d.get("offset", 0),
                              secrets=want_secrets(req), **filters_from(d))


@router.route("POST", "/api/v1/mailboxes", "write")
def mailboxes_create(hub, req):
    d = req.data()
    if d.get("items") is not None or d.get("lines") or (d.get("text") and not d.get("email")):
        return import_data(hub, req)
    return 201, hub.create_mailbox(d, actor(req))


@router.route("GET", "/api/v1/mailboxes/{email}", "read")
def mailbox_get(hub, req):
    return hub.get_mailbox(req.params["email"], want_secrets(req))


@router.route("PATCH", "/api/v1/mailboxes/{email}", "write")
@router.route("PUT", "/api/v1/mailboxes/{email}", "write")
def mailbox_update(hub, req):
    return hub.update_mailbox(req.params["email"], req.data(), actor(req))


@router.route("DELETE", "/api/v1/mailboxes/{email}", "write")
def mailbox_delete(hub, req):
    email = req.params["email"]
    hub._row(email)
    hub.delete_mailboxes([email], actor(req))
    return {"ok": True, "deleted": 1}


@router.route("POST", "/api/v1/mailboxes/bulk", "write")
def mailboxes_bulk(hub, req):
    d = req.data()
    action = str(d.get("action", ""))
    emails = list_param(d.get("emails"))
    if not emails:
        scope = d.get("filter") if isinstance(d.get("filter"), dict) else {}
        if not scope and not truthy(d.get("all")):
            raise ApiError(400, "empty", "вкажіть emails, filter або all=true")
        emails = hub.emails_matching(**filters_from(scope))
    if action == "delete":
        return {"ok": True, "deleted": hub.delete_mailboxes(emails, actor(req))}
    if action == "status":
        for email in emails:
            hub.set_status(email, str(d.get("status", "")), actor=actor(req))
        return {"ok": True, "updated": len(emails)}
    if action == "tags":
        changed = hub.bulk_tags(emails, d.get("add"), d.get("remove"))
        return {"ok": True, "updated": changed}
    if action == "check":
        return 202, hub.start_check_job(emails, actor(req))
    raise ApiError(400, "bad_action", "action має бути delete, status, tags або check")


@router.route("GET", "/api/v1/mailboxes/{email}/messages", "read")
def messages_list(hub, req):
    d = req.data()
    return hub.messages(req.params["email"], truthy(d.get("refresh")), to_int(d.get("limit"), 30, 1, 200))


@router.route("GET", "/api/v1/mailboxes/{email}/messages/{message_id}", "read")
def message_get(hub, req):
    return hub.get_message(req.params["email"], to_int(req.params["message_id"], 0))


def fetch_code(hub, req, email: str, default_wait: int = 0):
    d = req.data()
    wait = to_int(d.get("wait", d.get("timeout")), default_wait, 0, 900)
    hit = hub.wait_for_code(
        email, wait=wait, since=parse_ts(d.get("since")), sender=str(d.get("sender", "")),
        subject=str(d.get("subject", "")), fresh=truthy(d.get("fresh")), any_message=truthy(d.get("any")),
        regex=str(d.get("regex", "")), actor=actor(req))
    return hit, wait


@router.route("GET", "/api/v1/mailboxes/{email}/code", "code")
def code_get(hub, req):
    email = req.params["email"]
    hit, wait = fetch_code(hub, req, email)
    if str(req.data().get("format", "json")).lower() == "text":
        return Response.text(hit["code"] if hit else "")
    return {"found": True, **hit} if hit else {"found": False, "code": "", "email": email, "waited": wait}


@router.route("GET", "/api/v1/code", "code")
def code_alias(hub, req):
    email = str(req.data().get("email", "")).strip().lower()
    if not email:
        raise ApiError(400, "missing_email", "потрібен параметр email")
    req.params["email"] = email
    return code_get(hub, req)


@router.route("POST", "/api/v1/mailboxes/{email}/check", "code")
def mailbox_check(hub, req):
    return hub.check_mailbox(req.params["email"], actor(req))


@router.route("POST", "/api/v1/mailboxes/{email}/status", "code")
def mailbox_status(hub, req):
    d = req.data()
    return hub.set_status(req.params["email"], str(d.get("status", "")), d.get("note"), actor(req), to_int(d.get("ttl"), 0) or None)


@router.route("POST", "/api/v1/mailboxes/{email}/extend", "code")
def mailbox_extend(hub, req):
    return hub.extend_lease(req.params["email"], to_int(req.data().get("ttl"), 0) or None)


# ---------------------------------------------------------------- pool
@router.route("POST", "/api/v1/pool/acquire", "code")
def pool_acquire(hub, req):
    d = req.data()
    fmt = str(d.get("format", "json")).lower()
    secrets_on = want_secrets(req) or (fmt == "line" and (req.require("secrets") or True))
    out = hub.acquire(d.get("count", 1), to_int(d.get("ttl"), 0) or None, str(d.get("owner") or actor(req)),
                      str(d.get("tag", "")), secrets_on)
    if fmt in ("line", "email", "text"):
        rows = [m["line"] if fmt == "line" else m["email"] for m in out["items"]]
        return Response.text("\n".join(rows) + ("\n" if rows else ""))
    return out


@router.route("POST", "/api/v1/pool/release", "code")
def pool_release(hub, req):
    d = req.data()
    return hub.set_status(str(d.get("email", "")), str(d.get("status") or "used"), d.get("note"), actor(req))


# ---------------------------------------------------------------- import / export / checks
@router.route("POST", "/api/v1/import", "write")
def import_data(hub, req):
    d = req.data()
    text, filename = str(d.get("text") or d.get("lines") or ""), str(d.get("filename") or "")
    if req.files:
        filename, raw = next(iter(req.files.values()))
        text = parsing.decode_bytes(raw)
    elif d.get("items") is not None:
        text = json.dumps(d["items"])
    if not text.strip():
        raise ApiError(400, "empty", "немає даних для імпорту: надішліть text, lines, items або файл")
    dry = truthy(d.get("dry_run"))
    result = hub.import_text(text, filename, mode=str(d.get("mode") or "skip"), status=str(d.get("status") or ""),
                             tags=list_param(d.get("tags")), note=str(d.get("note") or ""), dry_run=dry, actor=actor(req))
    if truthy(d.get("check")) and not dry and result["emails"]:
        result["job"] = hub.start_check_job(result["emails"], actor(req))
    return result


@router.route("GET", "/api/v1/export", "read")
@router.route("POST", "/api/v1/export", "read")
def export_data(hub, req):
    d = req.data()
    secrets_on = want_secrets(req, default=req.identity.can("secrets"))
    emails = list_param(d.get("emails")) or None
    body, kind, filename = hub.export(str(d.get("format") or "txt").lower(), secrets_on, emails, **filters_from(d))
    response = Response.text(body, content_type=kind + "; charset=utf-8", filename="" if truthy(d.get("inline")) else filename)
    return response


@router.route("POST", "/api/v1/check", "code")
def check_many(hub, req):
    d = req.data()
    emails = list_param(d.get("emails"))
    return 202, hub.start_check_job(emails or None, actor(req), **({} if emails else filters_from(d)))


@router.route("GET", "/api/v1/jobs/{job_id}", "read")
def job_get(hub, req):
    job = hub.jobs.snapshot(req.params["job_id"])
    if job is None:
        raise ApiError(404, "not_found", "задачу не знайдено")
    return job


# ---------------------------------------------------------------- keys, webhooks, settings
@router.route("GET", "/api/v1/keys", "admin")
def keys_list(hub, req):
    return {"items": hub.auth.list_keys(), "scopes": list(SCOPES), "presets": {k: list(v) for k, v in PRESETS.items()}}


@router.route("POST", "/api/v1/keys", "admin")
def keys_create(hub, req):
    d = req.data()
    try:
        row, plain = hub.auth.create_key(str(d.get("name", "")), d.get("scopes") or d.get("preset") or "bas")
    except ValueError as exc:
        raise ApiError(400, "bad_key", str(exc)) from exc
    hub.event("key.created", row["name"], ",".join(row["scopes"]), actor(req))
    return 201, {**row, "key": plain}


@router.route("DELETE", "/api/v1/keys/{key_id}", "admin")
def keys_revoke(hub, req):
    if not hub.auth.revoke_key(to_int(req.params["key_id"], 0)):
        raise ApiError(404, "not_found", "ключ не знайдено")
    hub.event("key.revoked", req.params["key_id"], actor=actor(req))
    return {"ok": True}


@router.route("GET", "/api/v1/webhooks", "admin")
def hooks_list(hub, req):
    from .webhooks import EVENTS
    return {"items": hub.webhooks.list(), "events": list(EVENTS)}


@router.route("POST", "/api/v1/webhooks", "admin")
def hooks_create(hub, req):
    d = req.data()
    secret = str(d.get("secret") or "")
    generated = not secret
    if generated:
        import secrets as pysecrets
        secret = pysecrets.token_hex(16)
    try:
        hook = hub.webhooks.create(str(d.get("url", "")), secret, d.get("events"))
    except ValueError as exc:
        raise ApiError(400, "bad_webhook", str(exc)) from exc
    hub.event("webhook.created", hook["url"], actor=actor(req))
    return 201, {**hook, "secret": secret if generated else None}


@router.route("PATCH", "/api/v1/webhooks/{hook_id}", "admin")
def hooks_update(hub, req):
    try:
        hook = hub.webhooks.update(to_int(req.params["hook_id"], 0), req.data())
    except ValueError as exc:
        raise ApiError(400, "bad_webhook", str(exc)) from exc
    if hook is None:
        raise ApiError(404, "not_found", "вебхук не знайдено")
    return hook


@router.route("DELETE", "/api/v1/webhooks/{hook_id}", "admin")
def hooks_delete(hub, req):
    if not hub.webhooks.delete(to_int(req.params["hook_id"], 0)):
        raise ApiError(404, "not_found", "вебхук не знайдено")
    return {"ok": True}


@router.route("POST", "/api/v1/webhooks/{hook_id}/test", "admin")
def hooks_test(hub, req):
    status = hub.webhooks.test(to_int(req.params["hook_id"], 0))
    if status is None:
        raise ApiError(404, "not_found", "вебхук не знайдено")
    return {"status": status, "ok": status.startswith("2")}


@router.route("GET", "/api/v1/settings", "admin")
def settings_get(hub, req):
    return {"settings": hub.settings(), "defaults": SETTING_DEFAULTS}


@router.route("PUT", "/api/v1/settings", "admin")
@router.route("PATCH", "/api/v1/settings", "admin")
def settings_update(hub, req):
    patch = {k: v for k, v in req.data().items() if k in SETTING_DEFAULTS}
    return {"settings": hub.update_settings(patch, actor(req)), "defaults": SETTING_DEFAULTS}


# ---------------------------------------------------------------- BAS: legacy and text aliases
@router.route("GET", "/code", "code")
@router.route("GET", "/api/code", "code")
def legacy_code(hub, req):
    """Contract of the old mailhub: HTTP 200 with {"code": "..."}; empty code means "not yet"."""
    email = str(req.data().get("email", "")).strip().lower()
    if not email:
        raise ApiError(400, "missing_email", "потрібен параметр email")
    try:
        hit, _wait = fetch_code(hub, req, email, default_wait=90)
    except ApiError as exc:
        if exc.status == 404:
            return 404, {"error": exc.message}
        return {"code": "", "email": email, "error": exc.message}
    if hit:
        return {"code": hit["code"], "email": email, "received_at": hit["received_at"], "subject": hit["subject"]}
    return {"code": "", "email": email, "error": "код не надійшов за відведений час"}


@router.route("GET", "/bas/code", "code")
def bas_code(hub, req):
    email = str(req.data().get("email", "")).strip().lower()
    hit, _wait = fetch_code(hub, req, email, default_wait=90)
    return Response.text(hit["code"] if hit else "")


@router.route("GET", "/bas/next", "code")
@router.route("POST", "/bas/next", "code")
def bas_next(hub, req):
    d = req.data()
    fmt = str(d.get("format", "email")).lower()
    if fmt == "line":
        req.require("secrets")
    out = hub.acquire(1, to_int(d.get("ttl"), 0) or None, str(d.get("owner") or actor(req)), str(d.get("tag", "")),
                      secrets=fmt == "line")
    if fmt == "json":
        return out
    rows = [m["line"] if fmt == "line" else m["email"] for m in out["items"]]
    return Response.text("\n".join(rows))


@router.route("GET", "/bas/done", "code")
@router.route("POST", "/bas/done", "code")
def bas_done(hub, req):
    d = req.data()
    hub.set_status(str(d.get("email", "")), str(d.get("status") or "used"), d.get("note"), actor(req))
    return Response.text("ok")
