/**
 * LocalPM - Project Package Transfer & Version Diff
 * Реализация FR-17: формирование и приём пакетов *.lpmproject,
 * расчет контрольной суммы SHA-256 (Web Crypto API), сравнение версий при возврате
 */

export const TransferUtils = {
  // Compute SHA-256 checksum of arbitrary object via Web Crypto API with pure JS fallback
  async computeChecksum(data) {
    const jsonStr = JSON.stringify(data);
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(jsonStr);

    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      try {
        const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (e) {
        // Fallback to pure JS implementation
      }
    }

    // Pure JS SHA-256 fallback (RFC 6234 standard) for non-secure HTTP contexts or older engines
    return this.sha256Pure(dataBuffer);
  },

  sha256Pure(bytes) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    
    const bitLen = bytes.length * 8;
    const newLen = (((bytes.length + 8) >> 6) + 1) << 6;
    const padded = new Uint8Array(newLen);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(newLen - 4, bitLen & 0xffffffff, false);
    view.setUint32(newLen - 8, Math.floor(bitLen / 0x100000000), false);

    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let i = 0; i < newLen; i += 64) {
      for (let t = 0; t < 16; t++) {
        W[t] = view.getUint32(i + t * 4, false);
      }
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ ((~e) & g);
        const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) | 0;

        h = g;
        g = f;
        f = e;
        e = (d + temp1) | 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) | 0;
      }
      H[0] = (H[0] + a) | 0;
      H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0;
      H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0;
      H[7] = (H[7] + h) | 0;
    }

    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
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
