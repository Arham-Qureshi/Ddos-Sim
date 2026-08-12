import json

from fastapi import APIRouter, Depends, HTTPException

from api.deps import get_settings, get_state
from app.config import Settings
from app.schemas import (
    AttackRequest,
    ControlResponse,
    ControlStatus,
    MitigationRequest,
    VipBanRequest,
)
from app.state import AppState
from services.control_client import EngineUnavailable, send_command

router = APIRouter(tags=["control"])


def _status_help(reply: str) -> dict:
    """turn an OK:STATUS ... reply into a dict"""
    if reply.startswith("OK:STATUS "):
        try:
            return json.loads(reply[len("OK:STATUS "):])
        except ValueError:
            pass
    # default on anything unexpected
    return {"mitigation": True, "attack_running": False, "pid": 0}


async def _send_cmd(settings: Settings, cmd: str) -> ControlResponse:
    try:
        reply = await send_command(
            cmd, settings.control_host, settings.control_port,
            settings.control_timeout_s,
        )
    except EngineUnavailable as exc:
        raise HTTPException(
            status_code=503,
            detail={"ok": False, "reply": str(exc), "engine_reachable": False},
        ) from exc
    return ControlResponse(ok=reply.startswith("OK:"), reply=reply)


@router.get("/control/status", response_model=ControlStatus)
async def control_status(
    settings: Settings = Depends(get_settings),
) -> ControlStatus:
    try:
        reply = await send_command(
            "CMD_GET_STATUS", settings.control_host, settings.control_port,
            settings.control_timeout_s,
        )
    except EngineUnavailable:
        return ControlStatus(engine_reachable=False)
    d = _status_help(reply)
    return ControlStatus(
        mitigation_on=bool(d.get("mitigation", True)),
        attack_running=bool(d.get("attack_running", False)),
        pid=int(d.get("pid", 0)),
    )


@router.post("/control/attack", response_model=ControlResponse)
async def control_attack(
    body: AttackRequest,
    state: AppState = Depends(get_state),
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    remaining = await state.cooldown_remaining()
    if remaining > 0:
        raise HTTPException(
            status_code=429,
            detail={"ok": False, "reply": f"attack on cooldown; retry in {remaining:.1f}s",
                    "engine_reachable": True},
        )
    res = await _send_cmd(
        settings, f"CMD_START_ATTACK {body.rps} {body.threads} {body.duration}")
    if res.reply.startswith("OK:ATTACK_STARTED"):
        await state.note_attack_started()
    return res


@router.post("/control/attack/stop", response_model=ControlResponse)
async def control_attack_stop(settings: Settings = Depends(get_settings)) -> ControlResponse:
    return await _send_cmd(settings, "CMD_STOP_ATTACK")


@router.post("/control/mitigation", response_model=ControlResponse)
async def control_mitigation(
    body: MitigationRequest,
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    return await _send_cmd(settings, f"CMD_SET_MITIGATION {'on' if body.enabled else 'off'}")


@router.post("/control/vips/ban", response_model=ControlResponse)
async def control_vips_ban(
    body: VipBanRequest,
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    return await _send_cmd(settings, f"CMD_BAN_VIP {body.vip}")


@router.post("/control/vips/unban", response_model=ControlResponse)
async def control_vips_unban(
    body: VipBanRequest,
    settings: Settings = Depends(get_settings),
) -> ControlResponse:
    return await _send_cmd(settings, f"CMD_UNBAN_VIP {body.vip}")