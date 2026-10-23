/**
 * LocalPM - Excel / TSV Import and Export Module (SheetJS integration)
 * Реализация FR-5 (импорт XLSX, CSV, буфер обмена TSV, распознавание колонок)
 * и FR-15 (экспорт в XLSX с форматированием, листы "План", "Вехи", "Связи", "Сводка")
 */

import { DateUtils } from '../core/dates.js';
import { ValidationUtils } from '../core/validation.js';

export const XlsxIO = {
  // Column aliases for auto-mapping (FR-4.5.1)
  HEADER_MAPPINGS: {
    external_number: ['№', 'номер', 'id', 'код', 'wbs', 'код задачи', 'number', 'task id'],
    name: ['задача', 'название', 'наименование', 'работа', 'task', 'name', 'описание задачи', 'work'],
    duration_days: ['длительность', 'длит.', 'duration', 'срок', 'дни', 'длит'],
    start_date: ['начало', 'дата начала', 'start', 'начало работ', 'start date'],
    finish_date: ['окончание', 'дата окончания', 'finish', 'конец', 'завершение', 'finish date', 'end'],
    note: ['примечание', 'комментарий', 'note', 'notes', 'заметка', 'описание'],
    predecessors: ['предшественники', 'связи', 'predecessors', 'зависимости', 'preds'],
    is_milestone: ['веха', 'milestone', 'контрольная точка'],
    level: ['уровень', 'wbs', 'level', 'иерархия'],
    owner: ['ответственный', 'владелец', 'owner', 'исполнитель'],
    percent_complete: ['статус', 'процент завершения', '% готовности', '% выполнения', '%', 'progress']
  },

  // Parse clipboard text (TSV format from Excel / Sheets)
  parseTSV(rawText) {
    if (!rawText || !rawText.trim()) return [];
    const lines = rawText.trim().split(/\r?\n/);
    return lines.map(line => line.split('\t').map(cell => cell.trim()));
  },

  // Auto-detect columns from header row
  mapHeaders(headerRow) {
    const mapping = {};
    headerRow.forEach((col, idx) => {
      const cleanCol = String(col).toLowerCase().trim();
      for (const [key, aliases] of Object.entries(this.HEADER_MAPPINGS)) {
        if (aliases.includes(cleanCol) && mapping[key] === undefined) {
          mapping[key] = idx;
          break;
        }
      }
    });
    // Fallback if no name found: assume col 1 is name
    if (mapping.name === undefined && headerRow.length > 1) {
      mapping.name = 1;
    }
    return mapping;
  },

  // Parse rows array to tasks and dependencies
  processRows(rows, mapping, calendar) {
    const tasks = [];
    const dependenciesRaw = [];
    const warnings = [];
    let skipped = 0;

    rows.forEach((row, idx) => {
      const name = mapping.name !== undefined ? row[mapping.name] : '';
      if (!name || !name.trim()) {
        skipped++;
        return;
      }

      const extNum = mapping.external_number !== undefined && row[mapping.external_number]
        ? String(row[mapping.external_number]).trim()
        : String(tasks.length + 1);

      let duration = mapping.duration_days !== undefined ? DateUtils.parseDuration(row[mapping.duration_days]) : 1;
      let start = mapping.start_date !== undefined ? DateUtils.parseDate(row[mapping.start_date]) : null;
      let finish = mapping.finish_date !== undefined ? DateUtils.parseDate(row[mapping.finish_date]) : null;
      const note = mapping.note !== undefined ? (row[mapping.note] || '') : '';
      const owner = mapping.owner !== undefined ? (row[mapping.owner] || '') : '';
      const level = mapping.level !== undefined ? (parseInt(row[mapping.level], 10) || 0) : 0;
      
      let isMilestone = duration === 0;
      if (mapping.is_milestone !== undefined) {
        const mVal = String(row[mapping.is_milestone]).toLowerCase().trim();
        if (['да', 'yes', '1', 'true', '+', 'веха'].includes(mVal)) {
          isMilestone = true;
          duration = 0;
        }
      }

      const percent = mapping.percent_complete !== undefined
        ? Math.min(100, Math.max(0, parseInt(row[mapping.percent_complete], 10) || 0))
        : 0;

      const taskId = `task-${Date.now()}-${idx}`;
      tasks.push({
        id: taskId,
        external_number: extNum,
        name: name.trim(),
        duration_days: duration,
        start_date: start,
        finish_date: finish,
        is_milestone: isMilestone,
        note,
        owner,
        level,
        percent_complete: percent,
        sort_order: tasks.length
      });

      if (mapping.predecessors !== undefined && row[mapping.predecessors]) {
        dependenciesRaw.push({
          taskId,
          predStr: row[mapping.predecessors]
        });
      }
    });

    // Resolve dependencies
    const numToTaskMap = new Map();
    tasks.forEach(t => numToTaskMap.set(t.external_number, t));

    const finalDependencies = [];
    dependenciesRaw.forEach(item => {
      const parsedDeps = ValidationUtils.parsePredecessors(item.predStr);
      parsedDeps.forEach(pd => {
        const predTask = numToTaskMap.get(String(pd.predNumber));
        if (predTask) {
          finalDependencies.push({
            id: `dep-${item.taskId}-${predTask.id}`,
            pred_id: predTask.id,
            succ_id: item.taskId,
            type: pd.type,
            lag_workdays: pd.lag
          });
        } else {
          warnings.push(`Предшественник #${pd.predNumber} не найден для задачи "${item.taskId}"`);
        }
      });
    });

    return { tasks, dependencies: finalDependencies, skipped, warnings };
  },

  // Export project to XLSX using SheetJS
  exportToXlsx(project, tasks, dependencies, summaryData = {}) {
    if (typeof XLSX === 'undefined') {
      throw new Error('SheetJS (XLSX) библиотека не загружена');
    }

    const wb = XLSX.utils.book_new();

    // 1. Sheet "План" (FR-15.02)
    const taskRows = [
      ['№', 'Задача', 'Длительность', 'Начало', 'Окончание', 'Предшественники', 'Веха', '% завершения', 'Ответственный', 'Примечание']
    ];

    const taskMap = new Map(tasks.map(t => [t.id, t.external_number]));
    const depsBySucc = new Map();
    dependencies.forEach(d => {
      if (!depsBySucc.has(d.succ_id)) depsBySucc.set(d.succ_id, []);
      depsBySucc.get(d.succ_id).push(d);
    });

    tasks.forEach(t => {
      const indent = '  '.repeat(t.level || 0);
      const nameWithIndent = indent + (t.name || '');
      const predsStr = ValidationUtils.formatPredecessors(depsBySucc.get(t.id) || [], taskMap);
      
      // Escape excel formulas starting with =, +, -, @ (FR-17.10)
      const safeName = /^[=+\-@]/.test(nameWithIndent) ? `'${nameWithIndent}` : nameWithIndent;
      const safeNote = /^[=+\-@]/.test(t.note || '') ? `'${t.note}` : (t.note || '');

      taskRows.push([
        t.external_number || '',
        safeName,
        DateUtils.formatDuration(t.duration_days),
        DateUtils.formatRU(t.start_date),
        DateUtils.formatRU(t.finish_date),
        predsStr,
        t.is_milestone ? 'Да' : 'Нет',
        `${t.percent_complete || 0}%`,
        t.owner || '',
        safeNote
      ]);
    });

    const wsTasks = XLSX.utils.aoa_to_sheet(taskRows);
    wsTasks['!cols'] = [
      { wch: 8 },  // №
      { wch: 40 }, // Задача
      { wch: 14 }, // Длительность
      { wch: 12 }, // Начало
      { wch: 12 }, // Окончание
      { wch: 18 }, // Предшественники
      { wch: 8 },  // Веха
      { wch: 14 }, // %
      { wch: 20 }, // Ответственный
      { wch: 30 }  // Примечание
    ];
    XLSX.utils.book_append_sheet(wb, wsTasks, 'План');

    // 2. Sheet "Вехи" (FR-15.03)
    const milestoneRows = [['№', 'Веха', 'Дата', 'Предшественники', 'Ответственный']];
    tasks.filter(t => t.is_milestone).forEach(m => {
      milestoneRows.push([
        m.external_number || '',
        m.name,
        DateUtils.formatRU(m.start_date),
        ValidationUtils.formatPredecessors(depsBySucc.get(m.id) || [], taskMap),
        m.owner || ''
      ]);
    });
    const wsMilestones = XLSX.utils.aoa_to_sheet(milestoneRows);
    XLSX.utils.book_append_sheet(wb, wsMilestones, 'Вехи');

    // 3. Sheet "Связи" (FR-15.03)
    const depRows = [['Предшественник №', 'Предшественник задача', 'Тип связи', 'Лаг (д)', 'Последователь №', 'Последователь задача']];
    const fullTaskMap = new Map(tasks.map(t => [t.id, t]));
    dependencies.forEach(d => {
      const pred = fullTaskMap.get(d.pred_id);
      const succ = fullTaskMap.get(d.succ_id);
      if (pred && succ) {
        depRows.push([
          pred.external_number,
          pred.name,
          d.type,
          d.lag_workdays || 0,
          succ.external_number,
          succ.name
        ]);
      }
    });
    const wsDeps = XLSX.utils.aoa_to_sheet(depRows);
    XLSX.utils.book_append_sheet(wb, wsDeps, 'Связи');

    // Generate binary XLSX
    const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
};
