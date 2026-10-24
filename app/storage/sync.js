/**
 * LocalPM - Storage & File Synchronization Engine
 * Implements localpm-data.json sync, File System Access API with 700ms debounce,
 * version conflict detection, and workspace export/import (SPEC-LocalPM-003).
 */

import { db } from './db.js';

export const DB_FILE_NAME = 'localpm-data.json';
export const DB_PATH = './localpm-data.json';

export class SyncEngine {
  constructor(app) {
    this.app = app;
    this.dbMode = 'local'; // 'file' | 'fetch' | 'local-pending' | 'local'
    this.fileHandle = null;
    this.fileName = DB_FILE_NAME;
    this.fileDirty = false;
    this.fileSavedAt = null;
    this.fileWriteTimer = 0;
    this.pendingConflict = null;
  }

  async init() {
    // 1. Try to restore fileHandle from IndexedDB meta store
    try {
      this.fileHandle = await db.getMeta('fileHandle');
    } catch (e) {
      this.fileHandle = null;
    }

    // 2. Read IndexedDB projects
    const idbProjects = await db.getAllFullProjects();

    let fileData = null;
    let fileSource = null;

    if (this.fileHandle) {
      try {
        const perm = await this.fileHandle.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          fileData = await this.readHandleData();
          fileSource = 'file';
          this.fileName = this.fileHandle.name;
        } else {
          this.dbMode = 'local-pending';
        }
      } catch (e) {
        this.dbMode = 'local-pending';
      }
    }

    if (!fileData && !this.fileHandle) {
      fileData = await this.tryFetchDatabase();
      if (fileData) {
        fileSource = 'fetch';
        this.fileName = DB_FILE_NAME;
      }
    }

    if (fileData && Array.isArray(fileData.projects)) {
      const fMax = this.workspaceMaxUpdated(fileData.projects);
      const iMax = this.workspaceMaxUpdated(idbProjects);

      if (idbProjects.length && iMax > fMax + 1500) {
        // Local IndexedDB is newer than file by > 1.5s -> Conflict modal
        this.pendingConflict = { fileData, fileSource };
        this.app.projects = idbProjects;
        this.dbMode = 'local';
        this.fileDirty = true;
        this.updateDbChip();
        this.app.showConflictModal();
        return;
      } else {
        // File data is fresher or equal
        await this.applyWorkspace(fileData);
        this.dbMode = fileSource === 'file' ? 'file' : 'fetch';
      }
    } else if (idbProjects.length) {
      this.app.projects = idbProjects;
      this.dbMode = 'local';
    }

    this.updateDbChip();
  }

  workspaceMaxUpdated(projects) {
    let max = 0;
    for (const p of projects || []) {
      const ts = p.updatedAt || p.updated_at;
      if (ts) {
        const ms = new Date(ts).getTime();
        if (ms > max) max = ms;
      }
    }
    return max;
  }

  async tryFetchDatabase() {
    try {
      const res = await fetch(DB_PATH + '?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return null;
      const data = await res.json();
      if (data && data.format === 'localpm' && Array.isArray(data.projects)) {
        return data;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  async readHandleData() {
    const file = await this.fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  }

  async writeToHandle() {
    if (!this.fileHandle) return;
    const jsonStr = JSON.stringify(this.serializeWorkspace(), null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const writable = await this.fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    this.fileDirty = false;
    this.fileSavedAt = new Date().toISOString();
    this.updateDbChip();
  }

  serializeWorkspace() {
    return {
      format: 'localpm',
      formatVersion: 1,
      schemaVersion: 2,
      dataKind: 'database',
      exportedAt: new Date().toISOString(),
      projects: this.app.projects.map(p => ({
        ...p,
        tasks: p.tasks || [],
        dependencies: p.dependencies || []
      }))
    };
  }

  async applyWorkspace(data) {
    if (!data || !Array.isArray(data.projects)) return;
    this.app.projects = data.projects;
    await db.replaceAllProjects(data.projects);
    this.fileDirty = false;
    this.fileSavedAt = data.exportedAt || new Date().toISOString();
    this.updateDbChip();
  }

  markDirty() {
    this.fileDirty = true;
    this.updateDbChip();
    this.scheduleFileWrite();
  }

  scheduleFileWrite() {
    if (this.dbMode !== 'file' || !this.fileHandle) return;
    if (this.fileWriteTimer) clearTimeout(this.fileWriteTimer);
    this.fileWriteTimer = setTimeout(async () => {
      this.fileWriteTimer = 0;
      try {
        const perm = await this.fileHandle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') {
          this.updateDbChip();
          return;
        }
        await this.writeToHandle();
      } catch (e) {
        this.updateDbChip();
      }
    }, 700);
  }

  async linkViaFS() {
    if (!('showOpenFilePicker' in window)) {
      this.openFileViaInput();
      return;
    }
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'База LocalPM', accept: { 'application/json': ['.json'] } }]
      });
      this.fileHandle = handle;
      this.fileName = handle.name;
      await db.setMeta('fileHandle', handle);
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        const data = await this.readHandleData();
        await this.applyWorkspace(data);
        this.dbMode = 'file';
        this.app.renderAfterSync();
      } else {
        this.dbMode = 'local-pending';
      }
      this.updateDbChip();
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        alert('Не удалось подключить файл: ' + e.message);
      }
    }
  }

  async createViaFS() {
    if (!('showSaveFilePicker' in window)) {
      this.downloadCopy();
      return;
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: DB_FILE_NAME,
        types: [{ description: 'База LocalPM', accept: { 'application/json': ['.json'] } }]
      });
      this.fileHandle = handle;
      this.fileName = handle.name;
      await db.setMeta('fileHandle', handle);
      this.dbMode = 'file';
      await this.writeToHandle();
      this.updateDbChip();
      this.app.showToast(`Файл базы создан и подключён: ${handle.name}`, 'success');
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        alert('Не удалось создать файл: ' + e.message);
      }
    }
  }

  openFileViaInput() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const data = JSON.parse(reader.result);
          if (data.format !== 'localpm') throw new Error('Некорректный формат файла базы');
          await this.applyWorkspace(data);
          this.fileName = file.name;
          this.dbMode = 'local';
          this.updateDbChip();
          this.app.renderAfterSync();
          this.app.showToast(`Файл «${file.name}» загружен`, 'success');
        } catch (err) {
          alert('Файл не является базой LocalPM: ' + err.message);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  downloadCopy() {
    const blob = new Blob([JSON.stringify(this.serializeWorkspace(), null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = DB_FILE_NAME;
    a.click();
    URL.revokeObjectURL(a);
    this.fileDirty = false;
    this.fileSavedAt = new Date().toISOString();
    this.updateDbChip();
  }

  async resolveConflict(choice) {
    const pc = this.pendingConflict;
    this.pendingConflict = null;
    this.app.closeModal('modal-db-conflict');

    if (choice === 'local') {
      if (this.fileHandle) {
        this.dbMode = 'file';
        try {
          await this.writeToHandle();
        } catch (e) {
          this.fileDirty = true;
        }
      } else {
        this.fileDirty = true;
        alert('Локальная версия активна. Сохраните её в файл базы.');
      }
    } else if (pc) {
      await this.applyWorkspace(pc.fileData);
      this.dbMode = pc.fileSource === 'file' ? 'file' : 'fetch';
      this.app.renderAfterSync();
    }
    this.updateDbChip();
  }

  updateDbChip() {
    const chip = document.getElementById('db-chip');
    if (!chip) return;

    chip.classList.remove('dirty', 'synced');
    let text = '';
    if (this.dbMode === 'file') {
      text = `● БД: ${this.fileName} — ${this.fileDirty ? 'сохранение…' : 'синхронно'}`;
      chip.classList.add(this.fileDirty ? 'dirty' : 'synced');
    } else if (this.dbMode === 'fetch') {
      text = `● БД: ${DB_PATH} (чтение)${this.fileDirty ? ' — есть несохранённые' : ''}`;
      if (this.fileDirty) chip.classList.add('dirty');
    } else if (this.dbMode === 'local-pending') {
      text = '● БД: разрешите доступ к файлу';
      chip.classList.add('dirty');
    } else {
      text = `● БД: ${DB_FILE_NAME} (кэш)${this.fileDirty ? ' — несохранённые' : ''}`;
      if (this.fileDirty) chip.classList.add('dirty');
    }
    chip.textContent = text;
  }
}
