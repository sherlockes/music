import os
import shutil
import subprocess
import time
import logging
from typing import Dict, Any, List
from app.config import MUSIC_DIR, RCLONE_CONFIG, RCLONE_REMOTE

logger = logging.getLogger("rclone_service")

def format_bytes(size: int) -> str:
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024.0:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} PB"

def get_rclone_config_text() -> str:
    """Read the raw rclone.conf content."""
    if not RCLONE_CONFIG.exists():
        return ""
    try:
        with open(RCLONE_CONFIG, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        logger.error(f"Error reading rclone.conf: {e}")
        return ""

def save_rclone_config_text(config_text: str) -> bool:
    """Save raw text to rclone.conf."""
    try:
        RCLONE_CONFIG.parent.mkdir(parents=True, exist_ok=True)
        with open(RCLONE_CONFIG, "w", encoding="utf-8") as f:
            f.write(config_text)
        return True
    except Exception as e:
        logger.error(f"Error saving rclone.conf: {e}")
        return False

def get_mount_status() -> Dict[str, Any]:
    """Check storage usage and Rclone mount state."""
    is_mounted = False
    mount_type = "Local"
    
    # Check if /proc/mounts contains fuse.rclone or rclone on /mnt/cloud_music
    try:
        if os.path.exists("/proc/mounts"):
            with open("/proc/mounts", "r") as f:
                for line in f:
                    if str(MUSIC_DIR) in line and ("fuse" in line or "rclone" in line):
                        is_mounted = True
                        mount_type = "Rclone Cloud VFS"
                        break
    except Exception as e:
        logger.error(f"Error checking /proc/mounts: {e}")

    # Check disk usage
    usage_info = {"total": 0, "used": 0, "free": 0, "percent": 0.0, "total_str": "0 MB", "free_str": "0 MB"}
    try:
        usage = shutil.disk_usage(MUSIC_DIR)
        percent = (usage.used / usage.total * 100.0) if usage.total > 0 else 0.0
        usage_info = {
            "total": usage.total,
            "used": usage.used,
            "free": usage.free,
            "percent": round(percent, 1),
            "total_str": format_bytes(usage.total),
            "used_str": format_bytes(usage.used),
            "free_str": format_bytes(usage.free),
        }
    except Exception as e:
        logger.error(f"Error checking disk usage: {e}")

    # List configured remotes
    remotes = []
    try:
        cmd = ["rclone", "listremotes"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            remotes = [r.strip() for r in res.stdout.strip().split('\n') if r.strip()]
    except Exception as e:
        logger.error(f"Error running rclone listremotes: {e}")

    return {
        "mount_path": str(MUSIC_DIR),
        "is_mounted": is_mounted,
        "mount_type": mount_type,
        "active_remote": RCLONE_REMOTE or (remotes[0] if remotes else "Ninguno"),
        "available_remotes": remotes,
        "config_text": get_rclone_config_text(),
        "storage": usage_info
    }

def trigger_mount(remote_name: str) -> Dict[str, Any]:
    """Manually trigger rclone mount command after safely clearing local unmounted files."""
    if not remote_name:
        return {"success": False, "message": "No remote specified"}

    clean_remote = remote_name.strip()
    if not clean_remote.endswith(":"):
        clean_remote = f"{clean_remote}:"

    try:
        # 1. Unmount previous mount if active
        subprocess.run(["fusermount", "-u", "-z", str(MUSIC_DIR)], capture_output=True)
        time.sleep(0.8)

        # 2. Safety check: wipe local unmounted files ONLY if confirmed unmounted
        status_before = get_mount_status()
        if not status_before["is_mounted"]:
            logger.info("Directory is unmounted. Clearing local files from /mnt/cloud_music...")
            for item in MUSIC_DIR.iterdir():
                try:
                    if item.is_file() or item.is_symlink():
                        item.unlink()
                    elif item.is_dir():
                        shutil.rmtree(item)
                except Exception as e:
                    logger.error(f"Error removing local file {item}: {e}")

        # 3. Mount remote with robust timeouts and VFS options
        cmd = [
            "rclone", "mount", clean_remote, str(MUSIC_DIR),
            "--vfs-cache-mode", "full",
            "--vfs-cache-max-age", "24h",
            "--vfs-cache-poll-interval", "1m",
            "--vfs-read-ahead", "128M",
            "--buffer-size", "32M",
            "--timeout", "30s",
            "--contimeout", "15s",
            "--dir-cache-time", "15m",
            "--attr-timeout", "1s",
            "--allow-other",
            "--allow-non-empty",
            "--daemon"
        ]

        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            _, stderr = proc.communicate(timeout=4)
            if proc.returncode != 0:
                err_msg = stderr.decode('utf-8', errors='ignore') if stderr else "Mount command returned non-zero code"
                return {"success": False, "message": f"Error al montar '{clean_remote}': {err_msg}"}
        except subprocess.TimeoutExpired:
            pass

        for _ in range(10):
            time.sleep(0.5)
            status_after = get_mount_status()
            if status_after["is_mounted"]:
                return {"success": True, "message": f"Remoto '{clean_remote}' montado correctamente en {MUSIC_DIR}"}

        return {"success": False, "message": f"Remoto '{clean_remote}' ejecutado pero no se confirmó el montaje en {MUSIC_DIR}."}

    except Exception as e:
        logger.error(f"Error in trigger_mount: {e}")
        return {"success": False, "message": str(e)}

def trigger_unmount() -> Dict[str, Any]:
    """Unmount Rclone VFS."""
    try:
        res = subprocess.run(["fusermount", "-u", "-z", str(MUSIC_DIR)], capture_output=True, text=True)
        if res.returncode == 0:
            return {"success": True, "message": "Remoto desmontado."}
        return {"success": False, "message": f"Error al desmontar: {res.stderr}"}
    except Exception as e:
        return {"success": False, "message": str(e)}

def check_and_auto_remount() -> bool:
    """
    Watchdog check: verifies if rclone mount is active and responsive.
    If unmounted or stale, automatically attempts to remount.
    """
    try:
        status = get_mount_status()
        target_remote = status.get("active_remote") or RCLONE_REMOTE
        
        # If no remotes exist in config, nothing to mount
        if not target_remote or target_remote == "Ninguno":
            available = status.get("available_remotes", [])
            if available:
                target_remote = available[0]
            else:
                return False

        is_mounted = status.get("is_mounted", False)

        # Probe mount responsiveness if reported mounted
        if is_mounted:
            try:
                # Stat directory node with 5s timeout to verify FUSE responsiveness
                test_proc = subprocess.run(["stat", str(MUSIC_DIR)], capture_output=True, timeout=5)
                if test_proc.returncode == 0:
                    return True # Healthy mount
                else:
                    logger.warning("[Watchdog] Mount path is unresponsive (stale FUSE). Unmounting...")
                    trigger_unmount()
            except subprocess.TimeoutExpired:
                logger.warning("[Watchdog] Timeout accessing /mnt/cloud_music. Unmounting stale mount...")
                trigger_unmount()
                time.sleep(1)

        # Attempt auto-remount
        logger.info(f"[Watchdog] Auto-remounting Rclone remote '{target_remote}'...")
        res = trigger_mount(target_remote)
        return res.get("success", False)

    except Exception as e:
        logger.error(f"[Watchdog] Error in check_and_auto_remount: {e}")
        return False

