/**
 * Rclone & Cloud Storage Management Module (Direct Config Textarea Enabled)
 */
class RcloneManager {
    constructor() {
        this.status = null;
        this.init();
    }

    async init() {
        await this.fetchStatus();
    }

    async fetchStatus() {
        try {
            const response = await fetch('/api/rclone/status');
            if (response.ok) {
                this.status = await response.json();
                this.renderStatus();
            }
        } catch (err) {
            console.error("Error fetching Rclone status:", err);
        }
    }

    renderStatus() {
        if (!this.status) return;

        const elStatusBadge = document.getElementById('rclone-status-badge');
        const elMountPath = document.getElementById('rclone-mount-path');
        const elActiveRemote = document.getElementById('rclone-active-remote');
        const elStoragePercent = document.getElementById('rclone-storage-percent');
        const elStorageBar = document.getElementById('rclone-storage-bar');
        const elStorageUsed = document.getElementById('rclone-storage-used');
        const elStorageFree = document.getElementById('rclone-storage-free');
        const elStorageTotal = document.getElementById('rclone-storage-total');
        const elConfigTextarea = document.getElementById('rclone-config-textarea');

        if (elMountPath) elMountPath.innerText = this.status.mount_path || '/mnt/cloud_music';
        if (elActiveRemote) elActiveRemote.innerText = this.status.active_remote || 'Ninguno';

        if (elStatusBadge) {
            if (this.status.is_mounted) {
                elStatusBadge.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5';
                elStatusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> Montado (${this.status.mount_type})`;
            } else {
                elStatusBadge.className = 'px-3 py-1 rounded-full text-xs font-semibold bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center gap-1.5';
                elStatusBadge.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-400"></span> Local (/mnt/cloud_music)`;
            }
        }

        const s = this.status.storage || {};
        if (elStoragePercent) elStoragePercent.innerText = `${s.percent || 0}%`;
        if (elStorageBar) elStorageBar.style.width = `${s.percent || 0}%`;
        if (elStorageUsed) elStorageUsed.innerText = s.used_str || '0 B';
        if (elStorageFree) elStorageFree.innerText = s.free_str || '0 B';
        if (elStorageTotal) elStorageTotal.innerText = s.total_str || '0 B';

        // Fill config text if not actively focused by user
        if (elConfigTextarea && document.activeElement !== elConfigTextarea) {
            elConfigTextarea.value = this.status.config_text || '';
        }

        // Render remotes select
        const elRemotesSelect = document.getElementById('rclone-remotes-select');
        if (elRemotesSelect && this.status.available_remotes) {
            if (this.status.available_remotes.length === 0) {
                elRemotesSelect.innerHTML = `<option value="">No hay remotos configurados aún</option>`;
            } else {
                elRemotesSelect.innerHTML = this.status.available_remotes.map(r => 
                    `<option value="${r}" ${r === this.status.active_remote ? 'selected' : ''}>${r}</option>`
                ).join('');
            }
        }
    }

    async saveConfigText() {
        const elConfigTextarea = document.getElementById('rclone-config-textarea');
        if (!elConfigTextarea) return;

        const configText = elConfigTextarea.value;
        window.app.showNotification('Guardando rclone.conf...', 'info');

        try {
            const res = await fetch('/api/rclone/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config_text: configText })
            });

            const data = await res.json();
            if (data.success) {
                window.app.showNotification(data.message || 'Configuración rclone.conf guardada', 'success');
                await this.fetchStatus();
            } else {
                window.app.showNotification(data.detail || 'Error al guardar configuración', 'error');
            }
        } catch (err) {
            window.app.showNotification('Error de conexión al guardar rclone.conf', 'error');
        }
    }

    async mountSelectedRemote() {
        const elRemotesSelect = document.getElementById('rclone-remotes-select');
        if (!elRemotesSelect || !elRemotesSelect.value) {
            window.app.showNotification('Selecciona un remoto de Rclone', 'error');
            return;
        }

        const remoteName = elRemotesSelect.value;
        window.app.showNotification(`Montando '${remoteName}'...`, 'info');

        try {
            const res = await fetch('/api/rclone/mount', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ remote_name: remoteName })
            });
            const data = await res.json();
            if (data.success) {
                window.app.showNotification(data.message, 'success');
                await this.fetchStatus();
                if (window.app) window.app.loadLibrary();
            } else {
                window.app.showNotification(data.message, 'error');
            }
        } catch (err) {
            window.app.showNotification('Error al conectar con la API de Rclone', 'error');
        }
    }

    async unmountRemote() {
        window.app.showNotification('Desmontando remoto...', 'info');
        try {
            const res = await fetch('/api/rclone/unmount', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                window.app.showNotification(data.message, 'success');
                await this.fetchStatus();
                if (window.app) window.app.loadLibrary();
            } else {
                window.app.showNotification(data.message, 'error');
            }
        } catch (err) {
            window.app.showNotification('Error al desmontar', 'error');
        }
    }
}

window.rcloneMgr = new RcloneManager();
