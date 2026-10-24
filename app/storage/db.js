/**
 * LocalPM - IndexedDB Storage Layer
 * Offline-first, Persistent Storage request, atomic operations
 */

import { DB_CONFIG, SCHEMA_VERSION } from './schema.js';

class LocalPMDatabase {
  constructor() {
    this.db = null;
    this.isPersistent = false;
  }

  async init() {
    if (this.db) return this.db;

    // Check & request persistent storage (FR-4.02)
    if (navigator.storage && navigator.storage.persist) {
      try {
        this.isPersistent = await navigator.storage.persist();
      } catch (e) {
        console.warn('Persistent storage check failed:', e);
      }
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        DB_CONFIG.stores.forEach(storeInfo => {
          if (!db.objectStoreNames.contains(storeInfo.name)) {
            const store = db.createObjectStore(storeInfo.name, { keyPath: storeInfo.keyPath });
            storeInfo.indexes.forEach(idx => {
              store.createIndex(idx.name, idx.keyPath, { unique: false });
            });
          }
        });
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  // Generic helper for transaction
  async withTx(storeNames, mode, callback) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeNames, mode);
      let result;

      tx.oncomplete = () => resolve(result);
      tx.onerror = (e) => reject(e.target.error);
      tx.onabort = (e) => reject(new Error('Transaction aborted'));

      result = callback(tx);
    });
  }

  // --- Projects CRUD ---
  async getAllProjects() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('projects', 'readonly');
      const store = tx.objectStore('projects');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getProject(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('projects', 'readonly');
      const store = tx.objectStore('projects');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async saveProject(project) {
    project.updated_at = new Date().toISOString();
    project.revision = (project.revision || 0) + 1;
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      const req = store.put(project);
      req.onsuccess = () => resolve(project);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteProject(id) {
    await this.init();
    return this.withTx(['projects', 'tasks', 'dependencies'], 'readwrite', (tx) => {
      tx.objectStore('projects').delete(id);
      
      // Delete tasks
      const taskStore = tx.objectStore('tasks');
      const taskIdx = taskStore.index('project_id');
      const taskReq = taskIdx.getAllKeys(id);
      taskReq.onsuccess = () => {
        taskReq.result.forEach(taskId => taskStore.delete(taskId));
      };

      // Delete dependencies
      const depStore = tx.objectStore('dependencies');
      const depIdx = depStore.index('project_id');
      const depReq = depIdx.getAllKeys(id);
      depReq.onsuccess = () => {
        depReq.result.forEach(depId => depStore.delete(depId));
      };
    });
  }

  // --- Tasks & Dependencies CRUD ---
  async getProjectTasks(projectId) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('tasks', 'readonly');
      const store = tx.objectStore('tasks');
      const idx = store.index('project_id');
      const req = idx.getAll(projectId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getProjectDependencies(projectId) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('dependencies', 'readonly');
      const store = tx.objectStore('dependencies');
      const idx = store.index('project_id');
      const req = idx.getAll(projectId);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async saveProjectPlan(projectId, tasks, dependencies) {
    await this.init();
    return this.withTx(['projects', 'tasks', 'dependencies'], 'readwrite', (tx) => {
      // 1. Clear old tasks & deps for this project
      const taskStore = tx.objectStore('tasks');
      const taskIdx = taskStore.index('project_id');
      const taskKeysReq = taskIdx.getAllKeys(projectId);
      taskKeysReq.onsuccess = () => {
        taskKeysReq.result.forEach(k => taskStore.delete(k));
        // Add new tasks
        tasks.forEach(t => taskStore.put({ ...t, project_id: projectId }));
      };

      const depStore = tx.objectStore('dependencies');
      const depIdx = depStore.index('project_id');
      const depKeysReq = depIdx.getAllKeys(projectId);
      depKeysReq.onsuccess = () => {
        depKeysReq.result.forEach(k => depStore.delete(k));
        // Add new deps
        dependencies.forEach(d => depStore.put({ ...d, project_id: projectId }));
      };

      // Update project timestamp and revision
      const projStore = tx.objectStore('projects');
      const pReq = projStore.get(projectId);
      pReq.onsuccess = () => {
        const p = pReq.result;
        if (p) {
          p.updated_at = new Date().toISOString();
          p.revision = (p.revision || 0) + 1;
          projStore.put(p);
        }
      };
    });
  }

  // Retrieve project with embedded tasks and dependencies
  async getFullProject(projectId) {
    const project = await this.getProject(projectId);
    if (!project) return null;
    const tasks = await this.getProjectTasks(projectId);
    const dependencies = await this.getProjectDependencies(projectId);
    return {
      ...project,
      tasks,
      dependencies
    };
  }

  // Load all projects with their tasks and dependencies (for mirroring/saving localpm-data.json)
  async getAllFullProjects() {
    const projects = await this.getAllProjects();
    const full = [];
    for (const p of projects) {
      const fullP = await this.getFullProject(p.id);
      if (fullP) full.push(fullP);
    }
    return full;
  }

  // Replace all projects in IndexedDB with the provided full project array
  async replaceAllProjects(projects) {
    await this.init();
    return this.withTx(['projects', 'tasks', 'dependencies'], 'readwrite', (tx) => {
      const projStore = tx.objectStore('projects');
      const taskStore = tx.objectStore('tasks');
      const depStore = tx.objectStore('dependencies');

      projStore.clear();
      taskStore.clear();
      depStore.clear();

      for (const p of projects) {
        const { tasks = [], dependencies = [], ...meta } = p;
        projStore.put(meta);
        for (const t of tasks) {
          taskStore.put({ ...t, project_id: meta.id });
        }
        for (const d of dependencies) {
          depStore.put({ ...d, project_id: meta.id });
        }
      }
    });
  }

  // --- Settings ---
  async getSetting(key, defaultValue = null) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => resolve(defaultValue);
    });
  }

  async setSetting(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Meta store (for FileSystemFileHandle, workspace stats, etc.) ---
  async getMeta(key, defaultValue = null) {
    await this.init();
    return new Promise((resolve) => {
      const tx = this.db.transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : defaultValue);
      req.onerror = () => resolve(defaultValue);
    });
  }

  async setMeta(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

export const db = new LocalPMDatabase();
