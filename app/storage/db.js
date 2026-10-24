/**
 * LocalPM - Pure JSON Local Storage Engine
 * Полностью локальное хранилище в формате JSON без использования IndexedDB.
 * Сохраняет проекты, задачи, связи и настройки в localStorage в виде валидного JSON,
 * с поддержкой работы в оперативной памяти и зеркалированием в localpm-data.json.
 */

const STORAGE_KEY_PREFIX = 'localpm_json_v2_';
const WORKSPACE_KEY = `${STORAGE_KEY_PREFIX}workspace`;
const SETTINGS_KEY = `${STORAGE_KEY_PREFIX}settings`;
const META_KEY = `${STORAGE_KEY_PREFIX}meta`;

class LocalPMJsonDatabase {
  constructor() {
    this.memoryStore = {
      projects: [],
      settings: {},
      meta: {}
    };
    this.isPersistent = true;
    this._initialized = false;
  }

  _getItem(key) {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function') {
        return localStorage.getItem(key);
      }
    } catch (e) {}
    return null;
  }

  _setItem(key, val) {
    try {
      if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
        localStorage.setItem(key, val);
      }
    } catch (e) {}
  }

  async init() {
    if (this._initialized) return this;

    try {
      // 1. Попытка загрузить существующие проекты из localStorage (с fallback на backup)
      let rawWs = this._getItem(WORKSPACE_KEY);
      if (!rawWs) {
        rawWs = this._getItem(`${WORKSPACE_KEY}_backup`);
      }
      if (rawWs) {
        try {
          const parsed = JSON.parse(rawWs);
          if (Array.isArray(parsed)) {
            this.memoryStore.projects = parsed;
          } else if (parsed && Array.isArray(parsed.projects)) {
            this.memoryStore.projects = parsed.projects;
          }
        } catch (err) {
          const backupWs = this._getItem(`${WORKSPACE_KEY}_backup`);
          if (backupWs) {
            const parsedBackup = JSON.parse(backupWs);
            this.memoryStore.projects = Array.isArray(parsedBackup) ? parsedBackup : (parsedBackup.projects || []);
          }
        }
      }

      // 2. Попытка миграции старых данных из IndexedDB (если они были, переносим в JSON)
      if (this.memoryStore.projects.length === 0 && typeof indexedDB !== 'undefined') {
        await this._migrateFromLegacyIndexedDB();
      }

      // 3. Загрузка настроек и метаданных
      const rawSettings = this._getItem(SETTINGS_KEY);
      if (rawSettings) {
        this.memoryStore.settings = JSON.parse(rawSettings) || {};
      }

      const rawMeta = this._getItem(META_KEY);
      if (rawMeta) {
        this.memoryStore.meta = JSON.parse(rawMeta) || {};
      }

      this._persistWorkspace();
    } catch (e) {
      console.warn('[LocalPM JSON DB] Storage access warning, falling back to in-memory JSON:', e);
    }

    this._initialized = true;
    return this;
  }

  async _migrateFromLegacyIndexedDB() {
    try {
      await new Promise((resolve) => {
        const req = indexedDB.open('LocalPM_Database', 2);
        req.onsuccess = (e) => {
          const idb = e.target.result;
          if (!idb.objectStoreNames.contains('projects')) {
            idb.close();
            return resolve();
          }

          const tx = idb.transaction(['projects', 'tasks', 'dependencies'], 'readonly');
          const pStore = tx.objectStore('projects');
          const tStore = tx.objectStore('tasks');
          const dStore = tx.objectStore('dependencies');

          const pReq = pStore.getAll();
          const tReq = tStore.getAll();
          const dReq = dStore.getAll();

          tx.oncomplete = () => {
            const projects = pReq.result || [];
            const tasks = tReq.result || [];
            const deps = dReq.result || [];

            if (projects.length > 0) {
              const fullProjects = projects.map(p => ({
                ...p,
                tasks: tasks.filter(t => t.project_id === p.id),
                dependencies: deps.filter(d => d.project_id === p.id)
              }));
              this.memoryStore.projects = fullProjects;
              this._persistWorkspace();
              console.log(`[LocalPM JSON DB] Успешно перенесено ${fullProjects.length} проектов из IndexedDB в локальный JSON!`);
            }
            idb.close();
            resolve();
          };

          tx.onerror = () => {
            idb.close();
            resolve();
          };
        };
        req.onerror = () => resolve();
      });
    } catch (e) {
      // Игнорируем ошибки легаси миграции
    }
  }

  _persistWorkspace() {
    try {
      if (this.memoryStore.projects && this.memoryStore.projects.length > 0) {
        const jsonStr = JSON.stringify(this.memoryStore.projects);
        this._setItem(WORKSPACE_KEY, jsonStr);
        // Резервная копия на случай сбоя
        this._setItem(`${WORKSPACE_KEY}_backup`, jsonStr);
      } else {
        const jsonStr = JSON.stringify(this.memoryStore.projects);
        this._setItem(WORKSPACE_KEY, jsonStr);
      }
    } catch (e) {
      console.error('[LocalPM JSON DB] Ошибка записи в хранилище:', e);
    }
  }

  _persistSettings() {
    try {
      this._setItem(SETTINGS_KEY, JSON.stringify(this.memoryStore.settings));
    } catch (e) {
      console.error('[LocalPM JSON DB] Ошибка записи настроек в хранилище:', e);
    }
  }

  _persistMeta() {
    try {
      this._setItem(META_KEY, JSON.stringify(this.memoryStore.meta));
    } catch (e) {
      console.error('[LocalPM JSON DB] Ошибка записи мета в хранилище:', e);
    }
  }

  // --- Projects CRUD ---
  async getAllProjects() {
    await this.init();
    return this.memoryStore.projects.map(p => {
      const { tasks, dependencies, ...meta } = p;
      return { ...meta };
    });
  }

  async getProject(id) {
    await this.init();
    const proj = this.memoryStore.projects.find(p => p.id === id);
    if (!proj) return null;
    const { tasks, dependencies, ...meta } = proj;
    return { ...meta };
  }

  async saveProject(project) {
    await this.init();
    project.updated_at = new Date().toISOString();
    project.revision = (project.revision || 0) + 1;

    const idx = this.memoryStore.projects.findIndex(p => p.id === project.id);
    if (idx >= 0) {
      const existing = this.memoryStore.projects[idx];
      this.memoryStore.projects[idx] = {
        ...project,
        tasks: existing.tasks || [],
        dependencies: existing.dependencies || []
      };
    } else {
      this.memoryStore.projects.push({
        ...project,
        tasks: project.tasks || [],
        dependencies: project.dependencies || []
      });
    }

    this._persistWorkspace();
    return project;
  }

  async deleteProject(id) {
    await this.init();
    this.memoryStore.projects = this.memoryStore.projects.filter(p => p.id !== id);
    this._persistWorkspace();
    return true;
  }

  // --- Tasks & Dependencies CRUD ---
  async getProjectTasks(projectId) {
    await this.init();
    const proj = this.memoryStore.projects.find(p => p.id === projectId);
    return proj && proj.tasks ? JSON.parse(JSON.stringify(proj.tasks)) : [];
  }

  async getProjectDependencies(projectId) {
    await this.init();
    const proj = this.memoryStore.projects.find(p => p.id === projectId);
    return proj && proj.dependencies ? JSON.parse(JSON.stringify(proj.dependencies)) : [];
  }

  async saveProjectPlan(projectId, tasks, dependencies) {
    await this.init();
    const proj = this.memoryStore.projects.find(p => p.id === projectId);
    if (proj) {
      proj.tasks = JSON.parse(JSON.stringify(tasks.map(t => ({ ...t, project_id: projectId }))));
      proj.dependencies = JSON.parse(JSON.stringify(dependencies.map(d => ({ ...d, project_id: projectId }))));
      proj.updated_at = new Date().toISOString();
      proj.revision = (proj.revision || 0) + 1;
    } else {
      this.memoryStore.projects.push({
        id: projectId,
        name: 'Новый проект',
        updated_at: new Date().toISOString(),
        revision: 1,
        tasks: JSON.parse(JSON.stringify(tasks.map(t => ({ ...t, project_id: projectId })))),
        dependencies: JSON.parse(JSON.stringify(dependencies.map(d => ({ ...d, project_id: projectId }))))
      });
    }

    this._persistWorkspace();
    return true;
  }

  // Retrieve project with embedded tasks and dependencies
  async getFullProject(projectId) {
    await this.init();
    const proj = this.memoryStore.projects.find(p => p.id === projectId);
    if (!proj) return null;
    return JSON.parse(JSON.stringify(proj));
  }

  // Load all projects with their tasks and dependencies
  async getAllFullProjects() {
    await this.init();
    return JSON.parse(JSON.stringify(this.memoryStore.projects));
  }

  // Replace all projects with the provided full project array
  async replaceAllProjects(projects) {
    await this.init();
    this.memoryStore.projects = JSON.parse(JSON.stringify(projects.map(p => ({
      ...p,
      tasks: p.tasks || [],
      dependencies: p.dependencies || []
    }))));
    this._persistWorkspace();
    return true;
  }

  // --- Settings ---
  async getSetting(key, defaultValue = null) {
    await this.init();
    const val = this.memoryStore.settings[key];
    return val !== undefined ? val : defaultValue;
  }

  async setSetting(key, value) {
    await this.init();
    this.memoryStore.settings[key] = value;
    this._persistSettings();
    return true;
  }

  // --- Meta store ---
  async getMeta(key, defaultValue = null) {
    await this.init();
    const val = this.memoryStore.meta[key];
    return val !== undefined ? val : defaultValue;
  }

  async setMeta(key, value) {
    await this.init();
    this.memoryStore.meta[key] = value;
    this._persistMeta();
    return true;
  }
}

export const db = new LocalPMJsonDatabase();
