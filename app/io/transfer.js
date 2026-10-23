/**
 * LocalPM - Project Package Transfer & Version Diff
 * Реализация FR-17: формирование и приём пакетов *.lpmproject,
 * расчет контрольной суммы SHA-256 (Web Crypto API), сравнение версий при возврате
 */

export const TransferUtils = {
  // Compute SHA-256 checksum of arbitrary object via Web Crypto API
  async computeChecksum(data) {
    const jsonStr = JSON.stringify(data);
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(jsonStr);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  // Export project package (*.lpmproject)
  async createPackage({
    project,
    tasks,
    dependencies,
    calendar,
    senderName = 'Пользователь',
    senderOrg = '',
    recipientName = '',
    comment = '',
    kind = 'transfer', // 'transfer' | 'return'
    baseRevision = null
  }) {
    const packagePayload = {
      projectId: project.id,
      name: project.name,
      revision: project.revision || 1,
      baseRevision: baseRevision || project.revision || 1,
      changedAt: new Date().toISOString(),
      author: senderName,
      calendar: calendar || null,
      tasks: tasks.map(t => ({
        id: t.id,
        parent_id: t.parent_id,
        external_number: t.external_number,
        name: t.name,
        duration_days: t.duration_days,
        start_date: t.start_date,
        finish_date: t.finish_date,
        is_milestone: !!t.is_milestone,
        is_manual: !!t.is_manual,
        percent_complete: t.percent_complete || 0,
        owner: t.owner || '',
        note: t.note || ''
      })),
      dependencies: dependencies.map(d => ({
        pred_id: d.pred_id,
        succ_id: d.succ_id,
        type: d.type,
        lag_workdays: d.lag_workdays || 0
      }))
    };

    const checksum = await this.computeChecksum(packagePayload);

    const pkg = {
      format: 'localpm-project-package',
      formatVersion: 1,
      kind,
      packageId: crypto.randomUUID ? crypto.randomUUID() : `pkg-${Date.now()}`,
      createdAt: new Date().toISOString(),
      sender: { name: senderName, organization: senderOrg },
      recipient: { name: recipientName },
      comment,
      project: packagePayload,
      includeHistory: false,
      cipher: null,
      checksum
    };

    return pkg;
  },

  // Validate imported package
  async validatePackage(pkg) {
    if (!pkg || typeof pkg !== 'object') {
      return { valid: false, error: 'Неверный формат файла: ожидается JSON объект' };
    }
    if (pkg.format !== 'localpm-project-package' || pkg.formatVersion !== 1) {
      return { valid: false, error: 'Неподдерживаемый формат или версия пакета' };
    }
    if (!pkg.project || !pkg.project.projectId || !pkg.checksum) {
      return { valid: false, error: 'Пакет повреждён: отсутствуют ключевые метаданные' };
    }

    const calculatedChecksum = await this.computeChecksum(pkg.project);
    if (calculatedChecksum !== pkg.checksum) {
      return { valid: false, error: 'Контрольная сумма SHA-256 не совпадает! Файл повреждён или изменён.' };
    }

    return { valid: true, pkg };
  },

  // Compare versions (for return scenario FR-17.09)
  diffVersions(baseTasks, currentTasks, baseDeps, currentDeps) {
    const baseTaskMap = new Map(baseTasks.map(t => [t.id, t]));
    const curTaskMap = new Map(currentTasks.map(t => [t.id, t]));

    const addedTasks = [];
    const updatedTasks = [];
    const removedTasks = [];

    // Detect added & updated
    currentTasks.forEach(cur => {
      const base = baseTaskMap.get(cur.id);
      if (!base) {
        addedTasks.push(cur);
      } else {
        const changes = [];
        if (base.name !== cur.name) changes.push(`Название: "${base.name}" ➔ "${cur.name}"`);
        if (base.duration_days !== cur.duration_days) changes.push(`Длительность: ${base.duration_days}д ➔ ${cur.duration_days}д`);
        if (base.start_date !== cur.start_date) changes.push(`Начало: ${base.start_date} ➔ ${cur.start_date}`);
        if (base.finish_date !== cur.finish_date) changes.push(`Окончание: ${base.finish_date} ➔ ${cur.finish_date}`);
        if (base.percent_complete !== cur.percent_complete) changes.push(`Готовность: ${base.percent_complete}% ➔ ${cur.percent_complete}%`);
        if (changes.length > 0) {
          updatedTasks.push({ task: cur, changes });
        }
      }
    });

    // Detect removed
    baseTasks.forEach(base => {
      if (!curTaskMap.has(base.id)) {
        removedTasks.push(base);
      }
    });

    return {
      addedTasks,
      updatedTasks,
      removedTasks,
      totalChanges: addedTasks.length + updatedTasks.length + removedTasks.length
    };
  }
};
