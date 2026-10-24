/**
 * LocalPM - WBS & Tree calculations
 */

export const WbsUtils = {
  // Rebuild hierarchical structure, calculate levels, outline numbers (1, 1.1, 1.1.1)
  // and compute summary task dates and progress
  computeWbs(tasks, dependencies = [], calendar = null, DateUtils) {
    if (!tasks || tasks.length === 0) return [];

    // Map by id
    const taskMap = new Map();
    tasks.forEach((t, idx) => {
      taskMap.set(t.id, {
        ...t,
        sort_order: t.sort_order !== undefined ? t.sort_order : idx,
        children: [],
        level: 0,
        is_summary: false,
        total_float: t.total_float || 0,
        is_critical: !!t.is_critical
      });
    });

    // Build parent-child tree
    const rootNodes = [];
    tasks.forEach(t => {
      const node = taskMap.get(t.id);
      if (t.parent_id && taskMap.has(t.parent_id) && t.parent_id !== t.id) {
        taskMap.get(t.parent_id).children.push(node);
      } else {
        rootNodes.push(node);
      }
    });

    // Check summary tasks
    taskMap.forEach(node => {
      if (node.children.length > 0) {
        node.is_summary = true;
      }
    });

    // Assign WBS codes & levels
    function assignWbsAndLevel(node, prefix, lvl) {
      node.level = lvl;
      node.wbs = prefix;
      node.children.sort((a, b) => a.sort_order - b.sort_order);
      node.children.forEach((child, index) => {
        assignWbsAndLevel(child, `${prefix}.${index + 1}`, lvl + 1);
      });
    }

    rootNodes.sort((a, b) => a.sort_order - b.sort_order);
    rootNodes.forEach((root, idx) => {
      assignWbsAndLevel(root, `${idx + 1}`, 0);
    });

    // Rollup summary task dates, duration, percent complete (bottom-up post-order traversal)
    function rollup(node) {
      if (!node.children || node.children.length === 0) {
        return;
      }

      node.children.forEach(child => rollup(child));

      let minStart = null;
      let maxFinish = null;
      let totalDurationWork = 0;
      let completedDurationWork = 0;

      node.children.forEach(child => {
        if (child.start_date) {
          if (!minStart || child.start_date < minStart) minStart = child.start_date;
        }
        if (child.finish_date) {
          if (!maxFinish || child.finish_date > maxFinish) maxFinish = child.finish_date;
        }

        const dur = Math.max(1, child.duration_days || 1);
        totalDurationWork += dur;
        completedDurationWork += dur * ((child.percent_complete || 0) / 100);
      });

      if (minStart) node.start_date = minStart;
      if (maxFinish) node.finish_date = maxFinish;

      if (minStart && maxFinish && DateUtils) {
        node.duration_days = DateUtils.diffWorkingDays(minStart, maxFinish, calendar);
      }
      node.percent_complete = totalDurationWork > 0 
        ? Math.round((completedDurationWork / totalDurationWork) * 100) 
        : 0;
      node.is_milestone = false;
    }

    rootNodes.forEach(root => rollup(root));

    // Flatten back into display list in order of depth-first traversal
    const flatList = [];
    function flatten(node) {
      node.external_number = node.wbs;
      flatList.push(node);
      node.children.forEach(c => flatten(c));
    }
    rootNodes.forEach(root => flatten(root));

    return flatList;
  },

  // Indent task or block of tasks (strictly +1 level step: parent = nearest task above of same level)
  indent(tasks, targetTaskIds) {
    if (!tasks || tasks.length === 0) return tasks;
    const targetIds = Array.isArray(targetTaskIds) ? targetTaskIds : [targetTaskIds];
    if (targetIds.length === 0) return tasks;

    const selSet = new Set(targetIds);
    // Find roots of selection (tasks whose parent is not in selection)
    const roots = tasks.filter(t => selSet.has(t.id) && (!t.parent_id || !selSet.has(t.parent_id)));
    if (roots.length === 0) return tasks;

    const blockSet = this.subtreeIds(tasks, roots.map(t => t.id));
    const iF = tasks.findIndex(r => blockSet.has(r.id));
    if (iF <= 0) return tasks; // Cannot indent topmost row

    const rootLevel = tasks[iF].level !== undefined ? tasks[iF].level : 0;
    // Look backwards above block for nearest candidate of the SAME level (strict +1 level step)
    let cand = null;
    for (let i = iF - 1; i >= 0; i--) {
      if (!blockSet.has(tasks[i].id) && (tasks[i].level || 0) === rootLevel) {
        cand = tasks[i];
        break;
      }
    }

    if (!cand) {
      // If no task on exact same level, cannot indent further (would skip level)
      return tasks;
    }

    // Guard against circular hierarchy
    let cur = cand;
    let guard = 0;
    while (cur && guard++ < 60) {
      if (blockSet.has(cur.id)) return tasks;
      cur = cur.parent_id ? tasks.find(t => t.id === cur.parent_id) : null;
    }

    const candId = cand.id;
    return tasks.map(t => {
      if (roots.some(r => r.id === t.id)) {
        return { ...t, parent_id: candId };
      }
      return t;
    });
  },

  // Outdent task or block of tasks (make child of parent's parent, level - 1)
  outdent(tasks, targetTaskIds) {
    if (!tasks || tasks.length === 0) return tasks;
    const targetIds = Array.isArray(targetTaskIds) ? targetTaskIds : [targetTaskIds];
    if (targetIds.length === 0) return tasks;

    const selSet = new Set(targetIds);
    const roots = tasks.filter(t => selSet.has(t.id) && (!t.parent_id || !selSet.has(t.parent_id)));
    if (roots.length === 0) return tasks;

    const parentMap = new Map();
    tasks.forEach(t => {
      if (t.parent_id) {
        const p = tasks.find(pt => pt.id === t.parent_id);
        parentMap.set(t.id, p ? (p.parent_id || null) : null);
      }
    });

    let moved = false;
    const res = tasks.map(t => {
      if (roots.some(r => r.id === t.id) && t.parent_id) {
        moved = true;
        return { ...t, parent_id: parentMap.get(t.id) || null };
      }
      return t;
    });

    return moved ? res : tasks;
  },

  // Find all descendant IDs of given root task IDs
  subtreeIds(tasks, rootIds) {
    const set = new Set(rootIds);
    let changed = true;
    while (changed) {
      changed = false;
      tasks.forEach(t => {
        if (set.has(t.parent_id) && !set.has(t.id)) {
          set.add(t.id);
          changed = true;
        }
      });
    }
    return set;
  },

  // Structural reorder & reparenting with level clamping: level = clamp(target, 0, rowAbove.level + 1)
  applyStructuralMove(project, rootIds, target) {
    if (!project || !project.tasks || !rootIds || !rootIds.length) return false;
    const tasks = project.tasks;
    const blockSet = this.subtreeIds(tasks, rootIds);
    if (target.beforeId && blockSet.has(target.beforeId)) return false;

    const roots = rootIds.map(id => tasks.find(t => t.id === id)).filter(Boolean);
    if (!roots.length) return false;

    // Build visible/ordered list
    const ordered = [...tasks].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    const firstRoot = ordered.find(r => r.id === roots[0].id);
    const rootLevel = firstRoot ? (firstRoot.level || 0) : 0;

    const remaining = ordered.filter(r => !blockSet.has(r.id));
    let idx = target.beforeId ? remaining.findIndex(r => r.id === target.beforeId) : remaining.length;
    if (idx < 0) idx = remaining.length;

    const rowAbove = remaining[idx - 1];
    const maxLevel = rowAbove ? (rowAbove.level || 0) + 1 : 0;
    const targetLevel = target.level !== undefined ? target.level : rootLevel;
    const level = Math.min(Math.max(0, targetLevel), maxLevel);
    const delta = level - rootLevel;

    const blockRows = ordered.filter(r => blockSet.has(r.id)).map(r => ({
      ...r,
      level: Math.max(0, (r.level || 0) + delta)
    }));

    const newOrdered = [...remaining.slice(0, idx), ...blockRows, ...remaining.slice(idx)];

    // Reparent moved roots based on level
    roots.forEach(rt => {
      const pos = newOrdered.findIndex(r => r.id === rt.id);
      const myLevel = newOrdered[pos].level;
      let pid = null;
      for (let i = pos - 1; i >= 0; i--) {
        if (newOrdered[i].level <= myLevel - 1) {
          pid = newOrdered[i].id;
          break;
        }
      }
      rt.parent_id = pid;
    });

    // Guard against circular parent references
    roots.forEach(rt => {
      let cur = rt;
      let guard = 0;
      while (cur && cur.parent_id && guard++ < 60) {
        if (cur.parent_id === rt.id) {
          rt.parent_id = null;
          break;
        }
        cur = tasks.find(t => t.id === cur.parent_id);
      }
    });

    // Update sort_order for all tasks based on new sequence
    const posMap = new Map();
    newOrdered.forEach((r, i) => posMap.set(r.id, i));
    tasks.forEach(t => {
      if (posMap.has(t.id)) {
        t.sort_order = posMap.get(t.id);
      }
    });

    tasks.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
    return true;
  }
};
