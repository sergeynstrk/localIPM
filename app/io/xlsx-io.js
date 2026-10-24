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

    // Generate binary XLSX via SheetJS if available, otherwise pure native generator
    if (typeof XLSX !== 'undefined' && XLSX.write) {
      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      return new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    return this.makeNativeXlsx([
      { name: 'План', rows: taskRows },
      { name: 'Вехи', rows: milestoneRows },
      { name: 'Связи', rows: depRows }
    ]);
  },

  // Standalone native zero-dependency browser XLSX generator (pure OOXML + ZIP store)
  makeNativeXlsx(sheets) {
    let CRC_T = null;
    function crcTable() {
      if (CRC_T) return CRC_T;
      CRC_T = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        CRC_T[n] = c;
      }
      return CRC_T;
    }
    function crc32(u8) {
      const T = crcTable();
      let c = 0xFFFFFFFF;
      for (let i = 0; i < u8.length; i++) c = T[(c ^ u8[i]) & 255] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    function colName(i) {
      let s = '';
      i++;
      while (i) {
        i--;
        s = String.fromCharCode(65 + i % 26) + s;
        i = Math.floor(i / 26);
      }
      return s;
    }
    function xmlEsc(s) {
      return String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    }
    function sheetXml(rows) {
      let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
      rows.forEach((r, ri) => {
        x += `<row r="${ri + 1}">`;
        r.forEach((c, ci) => {
          const ref = colName(ci) + (ri + 1);
          if (typeof c === 'number' && isFinite(c)) {
            x += `<c r="${ref}"><v>${c}</v></c>`;
          } else {
            x += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`;
          }
        });
        x += '</row>';
      });
      return x + '</sheetData></worksheet>';
    }

    const enc = new TextEncoder();
    const files = {
      '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>',
      '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name).slice(0, 31)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>'
    };

    sheets.forEach((s, i) => {
      files['xl/worksheets/sheet' + (i + 1) + '.xml'] = sheetXml(s.rows);
    });

    const names = Object.keys(files);
    const chunks = [];
    const central = [];
    let off = 0;

    for (const n of names) {
      const nb = enc.encode(n);
      const data = enc.encode(files[n]);
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0, true);
      lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true);
      lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true);
      lh.setUint32(22, data.length, true);
      lh.setUint16(26, nb.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nb, data);
      central.push({ nb, crc, size: data.length, off });
      off += 30 + nb.length + data.length;
    }

    let cdSize = 0;
    const cd = [];
    for (const c of central) {
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, 0, true);
      ch.setUint16(14, 0, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.nb.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, c.off, true);
      cd.push(new Uint8Array(ch.buffer), c.nb);
      cdSize += 46 + c.nb.length;
    }

    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(4, central.length, true);
    end.setUint16(6, central.length, true);
    end.setUint32(8, cdSize, true);
    end.setUint32(12, off, true);
    end.setUint16(16, 0, true);

    return new Blob([...chunks, ...cd, new Uint8Array(end.buffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }
};
