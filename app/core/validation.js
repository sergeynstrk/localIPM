/**
 * LocalPM - Validation & Predecessors Syntax Parser
 * Поддерживает форматы: "3", "3,5", "3НС+2д", "3НС-1д", "4НН", "7ОО+3д", "8НО" (FS, SS, FF, SF)
 */

export const ValidationUtils = {
  // Parse predecessor string to dependency items
  // Returns: Array<{ predNumber, type, lag }>
  parsePredecessors(predString) {
    if (!predString) return [];
    const items = String(predString).split(/[;,]/).map(s => s.trim()).filter(Boolean);
    const result = [];

    // Regex for: <number> [FS|SS|FF|SF|НС|НН|ОО|НО] [+/- <number> [д|d]?]
    const regex = /^(\d+)(НС|НН|ОО|НО|FS|SS|FF|SF)?(?:([+-]\d+)(?:[дd])?)?$/i;

    for (const item of items) {
      const match = item.match(regex);
      if (match) {
        const num = parseInt(match[1], 10);
        let typeStr = (match[2] || 'FS').toUpperCase();
        // Normalize RU types to standard EN
        if (typeStr === 'НС') typeStr = 'FS';
        else if (typeStr === 'НН') typeStr = 'SS';
        else if (typeStr === 'ОО') typeStr = 'FF';
        else if (typeStr === 'НО') typeStr = 'SF';

        const lag = match[3] ? parseInt(match[3], 10) : 0;
        result.push({ predNumber: num, type: typeStr, lag });
      }
    }

    return result;
  },

  // Format dependency array back to MS Project predecessor string
  formatPredecessors(deps, taskMapByNum) {
    if (!deps || deps.length === 0) return '';
    return deps.map(d => {
      const num = taskMapByNum ? (taskMapByNum.get(d.pred_id) || d.pred_id) : d.pred_id;
      let typeStr = d.type || 'FS';
      let ruType = typeStr;
      if (typeStr === 'FS') ruType = 'НС';
      else if (typeStr === 'SS') ruType = 'НН';
      else if (typeStr === 'FF') ruType = 'ОО';
      else if (typeStr === 'SF') ruType = 'НО';

      // if FS and lag 0, can just write number
      if (ruType === 'НС' && (!d.lag_workdays || d.lag_workdays === 0)) {
        return `${num}`;
      }

      let lagStr = '';
      if (d.lag_workdays > 0) lagStr = `+${d.lag_workdays}д`;
      else if (d.lag_workdays < 0) lagStr = `${d.lag_workdays}д`;

      return `${num}${ruType}${lagStr}`;
    }).join(';');
  },

  // Detect cycle in dependencies graph
  // Returns: { hasCycle: boolean, cyclePath: string[] }
  findCycle(tasks, dependencies) {
    const taskIds = new Set(tasks.map(t => t.id));
    const adj = new Map();
    taskIds.forEach(id => adj.set(id, []));

    dependencies.forEach(d => {
      if (taskIds.has(d.pred_id) && taskIds.has(d.succ_id)) {
        adj.get(d.pred_id).push(d.succ_id);
      }
    });

    const visited = new Map(); // id -> 'visiting' | 'visited'
    const parent = new Map();
    let cyclePath = [];

    function dfs(u) {
      visited.set(u, 'visiting');
      for (const v of (adj.get(u) || [])) {
        if (visited.get(v) === 'visiting') {
          // Cycle found
          cyclePath = [v, u];
          let curr = u;
          while (parent.has(curr) && parent.get(curr) !== v) {
            curr = parent.get(curr);
            cyclePath.push(curr);
          }
          cyclePath.push(v);
          cyclePath.reverse();
          return true;
        }
        if (!visited.has(v)) {
          parent.set(v, u);
          if (dfs(v)) return true;
        }
      }
      visited.set(u, 'visited');
      return false;
    }

    for (const id of taskIds) {
      if (!visited.has(id)) {
        if (dfs(id)) {
          return { hasCycle: true, cyclePath };
        }
      }
    }

    return { hasCycle: false, cyclePath: [] };
  },

  // Audit plan for common issues (FR-4.07, FR-4.13)
  auditPlan(tasks, dependencies) {
    const issues = [];
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const succMap = new Map();
    const predMap = new Map();

    tasks.forEach(t => {
      succMap.set(t.id, []);
      predMap.set(t.id, []);
    });

    dependencies.forEach(d => {
      if (predMap.has(d.succ_id)) predMap.get(d.succ_id).push(d);
      if (succMap.has(d.pred_id)) succMap.get(d.pred_id).push(d);
    });

    // Check cycles
    const cycle = this.findCycle(tasks, dependencies);
    if (cycle.hasCycle) {
      const names = cycle.cyclePath.map(id => (taskMap.get(id) ? taskMap.get(id).name : id));
      issues.push({
        severity: 'error',
        code: 'CYCLE_DETECTED',
        message: `Обнаружен цикл в связях: ${names.join(' ➔ ')}`
      });
    }

    // Check individual tasks
    tasks.forEach(t => {
      if (!t.name || !t.name.trim()) {
        issues.push({
          severity: 'error',
          taskId: t.id,
          message: `Задача #${t.external_number || t.id} не имеет названия`
        });
      }

      if (t.is_milestone && t.duration_days > 0) {
        issues.push({
          severity: 'warning',
          taskId: t.id,
          message: `Веха #${t.external_number || t.name} имеет длительность ${t.duration_days}д (должно быть 0)`
        });
      }

      if (t.start_date && t.finish_date && t.finish_date < t.start_date) {
        issues.push({
          severity: 'error',
          taskId: t.id,
          message: `Задача "${t.name}" имеет дату окончания раньше начала`
        });
      }

      // Check dangling/isolated tasks if multiple tasks exist
      if (tasks.length > 2 && !t.parent_id && (!t.children || t.children.length === 0)) {
        const preds = predMap.get(t.id) || [];
        const succs = succMap.get(t.id) || [];
        if (preds.length === 0 && succs.length === 0) {
          issues.push({
            severity: 'info',
            taskId: t.id,
            message: `Задача "${t.name}" не имеет предшественников и последователей`
          });
        }
      }
    });

    return issues;
  }
};
