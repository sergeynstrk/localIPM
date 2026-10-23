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

  // Indent task (make child of previous sibling)
  indent(tasks, targetTaskId) {
    const idx = tasks.findIndex(t => t.id === targetTaskId);
    if (idx <= 0) return tasks; // Cannot indent the very first task
    const prevTask = tasks[idx - 1];
    
    // We make prevTask the parent if they are currently on the same level or prevTask is sibling
    return tasks.map(t => {
      if (t.id === targetTaskId) {
        return { ...t, parent_id: prevTask.id };
      }
      return t;
    });
  },

  // Outdent task (make child of parent's parent)
  outdent(tasks, targetTaskId) {
    const current = tasks.find(t => t.id === targetTaskId);
    if (!current || !current.parent_id) return tasks;
    const parent = tasks.find(t => t.id === current.parent_id);
    const newParentId = parent ? (parent.parent_id || null) : null;

    return tasks.map(t => {
      if (t.id === targetTaskId) {
        return { ...t, parent_id: newParentId };
      }
      return t;
    });
  }
};
