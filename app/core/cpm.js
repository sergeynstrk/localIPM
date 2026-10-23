/**
 * LocalPM - Critical Path Method (CPM) Calculation Engine
 * Прямой проход (ES, EF), обратный проход (LS, LF), резерв (Total Float), критический путь.
 * Поддерживает 4 типа связей (FS, SS, FF, SF), лаги в рабочих днях, фиксацию дат (is_manual).
 */

import { DateUtils } from './dates.js';
import { ValidationUtils } from './validation.js';
import { WbsUtils } from './wbs.js';

export const CpmEngine = {
  calculate({ tasks, dependencies = [], projectStartDate, calendar = null }) {
    if (!tasks || tasks.length === 0) {
      return { tasks: [], issues: [], criticalPathCount: 0 };
    }

    const issues = ValidationUtils.auditPlan(tasks, dependencies);
    const cycle = ValidationUtils.findCycle(tasks, dependencies);
    if (cycle.hasCycle) {
      return {
        tasks,
        issues,
        error: 'CYCLE_DETECTED',
        cyclePath: cycle.cyclePath,
        criticalPathCount: 0
      };
    }

    // Prepare map of leaf tasks (only leaf tasks are scheduled directly by CPM; summary tasks are rolled up)
    const taskMap = new Map();
    tasks.forEach(t => {
      taskMap.set(t.id, {
        ...t,
        duration_days: t.is_milestone ? 0 : (t.duration_days !== undefined ? t.duration_days : 1),
        is_milestone: t.duration_days === 0 || !!t.is_milestone,
        early_start: null,
        early_finish: null,
        late_start: null,
        late_finish: null,
        total_float: 0,
        is_critical: false
      });
    });

    // Detect children / summary
    const parentMap = new Map();
    tasks.forEach(t => {
      if (t.parent_id && taskMap.has(t.parent_id)) {
        if (!parentMap.has(t.parent_id)) parentMap.set(t.parent_id, []);
        parentMap.get(t.parent_id).push(t.id);
      }
    });

    const isLeaf = (id) => !parentMap.has(id) || parentMap.get(id).length === 0;

    // Build dependency adjacency lists for leaf tasks
    const predsMap = new Map(); // succ_id -> [ { pred_id, type, lag } ]
    const succsMap = new Map(); // pred_id -> [ { succ_id, type, lag } ]
    tasks.forEach(t => {
      predsMap.set(t.id, []);
      succsMap.set(t.id, []);
    });

    dependencies.forEach(d => {
      if (taskMap.has(d.pred_id) && taskMap.has(d.succ_id)) {
        predsMap.get(d.succ_id).push(d);
        succsMap.get(d.pred_id).push(d);
      }
    });

    const baseProjectStart = DateUtils.ensureWorkingDay(
      projectStartDate || DateUtils.formatISO(new Date()),
      calendar,
      true
    );

    // Topological Sort for forward pass
    const inDegree = new Map();
    tasks.forEach(t => inDegree.set(t.id, 0));
    dependencies.forEach(d => {
      if (inDegree.has(d.succ_id)) {
        inDegree.set(d.succ_id, inDegree.get(d.succ_id) + 1);
      }
    });

    const queue = [];
    tasks.forEach(t => {
      if (inDegree.get(t.id) === 0) queue.push(t.id);
    });

    const topoOrder = [];
    while (queue.length > 0) {
      const u = queue.shift();
      topoOrder.push(u);
      for (const edge of (succsMap.get(u) || [])) {
        const v = edge.succ_id;
        inDegree.set(v, inDegree.get(v) - 1);
        if (inDegree.get(v) === 0) queue.push(v);
      }
    }

    // In case of disconnected or items missing from topoOrder
    const topoSet = new Set(topoOrder);
    tasks.forEach(t => {
      if (!topoSet.has(t.id)) {
        topoOrder.push(t.id);
        topoSet.add(t.id);
      }
    });

    // 1. FORWARD PASS (Early Start, Early Finish)
    for (const id of topoOrder) {
      const t = taskMap.get(id);

      // If manually scheduled and has dates, keep them
      if (t.is_manual && t.start_date && t.finish_date) {
        t.early_start = t.start_date;
        t.early_finish = t.finish_date;
        continue;
      }

      let earliestAllowedStart = baseProjectStart;
      const preds = predsMap.get(id) || [];

      for (const dep of preds) {
        const p = taskMap.get(dep.pred_id);
        if (!p || !p.early_start || !p.early_finish) continue;

        const lag = dep.lag_workdays || 0;
        let candidateStart = null;

        // Rules according to 4.14.1
        if (dep.type === 'FS') {
          // Finish-to-Start: Start(B) >= Finish(A) + 1 working day + lag
          // If predecessor finishes on Friday, next working day is Monday (1 working day shift)
          const nextDay = DateUtils.addLagWorkingDays(p.early_finish, 1, calendar);
          candidateStart = DateUtils.addLagWorkingDays(nextDay, lag, calendar);
        } else if (dep.type === 'SS') {
          // Start-to-Start: Start(B) >= Start(A) + lag
          candidateStart = DateUtils.addLagWorkingDays(p.early_start, lag, calendar);
        } else if (dep.type === 'FF') {
          // Finish-to-Finish: Finish(B) >= Finish(A) + lag
          const targetFinish = DateUtils.addLagWorkingDays(p.early_finish, lag, calendar);
          // compute start from target finish: Start = Finish - (Duration - 1)
          const dur = t.duration_days;
          candidateStart = dur <= 0 ? targetFinish : DateUtils.addLagWorkingDays(targetFinish, -(dur - 1), calendar);
        } else if (dep.type === 'SF') {
          // Start-to-Finish: Finish(B) >= Start(A) + lag
          const targetFinish = DateUtils.addLagWorkingDays(p.early_start, lag, calendar);
          const dur = t.duration_days;
          candidateStart = dur <= 0 ? targetFinish : DateUtils.addLagWorkingDays(targetFinish, -(dur - 1), calendar);
        }

        if (candidateStart && candidateStart > earliestAllowedStart) {
          earliestAllowedStart = candidateStart;
        }
      }

      if (t.start_date && !t.is_manual && preds.length === 0) {
        // If start date was explicitly set by user and no predecessors
        if (t.start_date > earliestAllowedStart) {
          earliestAllowedStart = t.start_date;
        }
      }

      t.early_start = DateUtils.ensureWorkingDay(earliestAllowedStart, calendar, true);
      if (t.duration_days === 0 || t.is_milestone) {
        t.early_finish = t.early_start;
      } else {
        t.early_finish = DateUtils.addWorkingDays(t.early_start, t.duration_days, calendar);
      }

      t.start_date = t.early_start;
      t.finish_date = t.early_finish;
    }

    // 2. BACKWARD PASS (Late Start, Late Finish)
    let projectFinishDate = baseProjectStart;
    taskMap.forEach(t => {
      if (t.early_finish && t.early_finish > projectFinishDate) {
        projectFinishDate = t.early_finish;
      }
    });

    const reverseTopoOrder = [...topoOrder].reverse();

    for (const id of reverseTopoOrder) {
      const t = taskMap.get(id);
      const succs = succsMap.get(id) || [];

      if (succs.length === 0) {
        t.late_finish = projectFinishDate;
      } else {
        let latestAllowedFinish = null;

        for (const dep of succs) {
          const s = taskMap.get(dep.succ_id);
          if (!s || !s.late_start || !s.late_finish) continue;

          const lag = dep.lag_workdays || 0;
          let candidateFinish = null;

          if (dep.type === 'FS') {
            // Finish(A) <= Start(B) - 1 - lag
            const prevDay = DateUtils.addLagWorkingDays(s.late_start, -1, calendar);
            candidateFinish = DateUtils.addLagWorkingDays(prevDay, -lag, calendar);
          } else if (dep.type === 'SS') {
            // Start(A) <= Start(B) - lag  => Finish(A) = Start(A) + Dur - 1
            const maxStart = DateUtils.addLagWorkingDays(s.late_start, -lag, calendar);
            candidateFinish = DateUtils.addWorkingDays(maxStart, t.duration_days, calendar);
          } else if (dep.type === 'FF') {
            // Finish(A) <= Finish(B) - lag
            candidateFinish = DateUtils.addLagWorkingDays(s.late_finish, -lag, calendar);
          } else if (dep.type === 'SF') {
            // Start(A) <= Finish(B) - lag
            const maxStart = DateUtils.addLagWorkingDays(s.late_finish, -lag, calendar);
            candidateFinish = DateUtils.addWorkingDays(maxStart, t.duration_days, calendar);
          }

          if (candidateFinish) {
            if (!latestAllowedFinish || candidateFinish < latestAllowedFinish) {
              latestAllowedFinish = candidateFinish;
            }
          }
        }

        t.late_finish = latestAllowedFinish || projectFinishDate;
      }

      if (t.duration_days === 0 || t.is_milestone) {
        t.late_start = t.late_finish;
      } else {
        t.late_start = DateUtils.addLagWorkingDays(t.late_finish, -(t.duration_days - 1), calendar);
      }

      // Total float in working days
      if (t.early_start === t.late_start) {
        t.total_float = 0;
        t.is_critical = true;
      } else {
        const floatDays = DateUtils.diffWorkingDays(t.early_start, t.late_start, calendar) - 1;
        t.total_float = Math.max(0, isNaN(floatDays) ? 0 : floatDays);
        t.is_critical = t.total_float <= 0;
      }
    }

    // 3. Roll up summary tasks using WBS
    const scheduledList = Array.from(taskMap.values());
    const rolledUpList = WbsUtils.computeWbs(scheduledList, dependencies, calendar, DateUtils);

    const criticalPathCount = rolledUpList.filter(t => t.is_critical && !t.is_summary).length;

    return {
      tasks: rolledUpList,
      issues,
      criticalPathCount,
      projectStartDate: baseProjectStart,
      projectFinishDate
    };
  }
};
