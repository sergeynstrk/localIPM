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
    let hardConstraintsCount = 0;
    let longTasksCount = 0;
    let missingPredsCount = 0;
    let missingSuccsCount = 0;
    let highFloatCount = 0;

    tasks.forEach(t => {
      if (!t.name || !t.name.trim()) {
        issues.push({
          severity: 'error',
          taskId: t.id,
          taskName: t.name || `#${t.external_number}`,
          code: 'NO_NAME',
          message: `Задача #${t.external_number || t.id} не имеет наименования`
        });
      }

      if (t.is_milestone && t.duration_days > 0) {
        issues.push({
          severity: 'warning',
          taskId: t.id,
          taskName: t.name,
          code: 'MILESTONE_DURATION',
          message: `Веха «${t.name}» имеет длительность ${t.duration_days}д (у вех должно быть 0)`
        });
      }

      if (t.start_date && t.finish_date && t.finish_date < t.start_date) {
        issues.push({
          severity: 'error',
          taskId: t.id,
          taskName: t.name,
          code: 'DATES_INVERTED',
          message: `Задача «${t.name}»: дата окончания раньше даты начала`
        });
      }

      // Long tasks check (> 20 working days without decomposition)
      if (!t.is_summary && !t.is_milestone && t.duration_days > 20) {
        longTasksCount++;
        issues.push({
          severity: 'warning',
          taskId: t.id,
          taskName: t.name,
          code: 'LONG_TASK',
          message: `Длинная задача «${t.name}» (${t.duration_days} раб. дн.). Рекомендуется декомпозировать на подзадачи (≤20д)`
        });
      }

      // Hard constraint or manual lock
      if (t.is_manual) {
        hardConstraintsCount++;
        issues.push({
          severity: 'info',
          taskId: t.id,
          taskName: t.name,
          code: 'MANUAL_CONSTRAINT',
          message: `Задача «${t.name}» зафиксирована вручную (жесткая дата)`
        });
      }

      // High Total Float (> 44 working days)
      if (!t.is_summary && t.total_float > 44) {
        highFloatCount++;
        issues.push({
          severity: 'info',
          taskId: t.id,
          taskName: t.name,
          code: 'HIGH_FLOAT',
          message: `Большой резерв времени у «${t.name}» (${t.total_float} раб. дн.)`
        });
      }

      // Check dangling/isolated tasks (missing predecessors or successors)
      if (tasks.length > 2 && !t.is_summary && !t.parent_id) {
        const preds = predMap.get(t.id) || [];
        const succs = succMap.get(t.id) || [];
        if (preds.length === 0 && !t.is_milestone) {
          missingPredsCount++;
          issues.push({
            severity: 'warning',
            taskId: t.id,
            taskName: t.name,
            code: 'MISSING_PREDECESSOR',
            message: `Висячее начало: задача «${t.name}» не имеет предшественников`
          });
        }
        if (succs.length === 0 && !t.is_milestone) {
          missingSuccsCount++;
          issues.push({
            severity: 'warning',
            taskId: t.id,
            taskName: t.name,
            code: 'MISSING_SUCCESSOR',
            message: `Висячий конец: задача «${t.name}» не имеет последователей`
          });
        }
      }
    });

    // Check negative lags (leads) in dependencies
    let negativeLagCount = 0;
    dependencies.forEach(d => {
      if (d.lag_workdays < 0) {
        negativeLagCount++;
        const pName = taskMap.get(d.pred_id)?.name || d.pred_id;
        const sName = taskMap.get(d.succ_id)?.name || d.succ_id;
        issues.push({
          severity: 'warning',
          code: 'NEGATIVE_LAG',
          message: `Отрицательный лаг (${d.lag_workdays}д) между «${pName}» и «${sName}». Скрытый риск расписания`
        });
      }
    });

    // Compute Health Quality Score (0 to 100%)
    let penalty = 0;
    if (cycle.hasCycle) penalty += 50;
    penalty += issues.filter(i => i.severity === 'error' && i.code !== 'CYCLE_DETECTED').length * 15;
    penalty += (missingPredsCount + missingSuccsCount) * 4;
    penalty += longTasksCount * 3;
    penalty += negativeLagCount * 5;
    const healthScore = Math.max(0, Math.min(100, Math.round(100 - penalty)));

    return {
      issues,
      healthScore,
      stats: {
        totalTasks: tasks.length,
        missingPredsCount,
        missingSuccsCount,
        longTasksCount,
        negativeLagCount,
        hasCycle: cycle.hasCycle
      }
    };
  }
};
