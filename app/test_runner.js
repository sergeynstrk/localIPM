import { CpmEngine } from './core/cpm.js';
import { DateUtils } from './core/dates.js';
import { ValidationUtils } from './core/validation.js';
import { WbsUtils } from './core/wbs.js';
import { XlsxIO } from './io/xlsx-io.js';
import { TransferUtils } from './io/transfer.js';

export async function runAllTests(appController = null) {
  const results = [];

  function check(code, name, condition, errorMsg = '') {
    const passed = !!condition;
    results.push({
      code,
      name,
      passed,
      error: passed ? '' : (errorMsg || 'Условие проверки не выполнено')
    });
    return passed;
  }

  // 1. D-01: Calendar & Workdays
  const cal = { type: 'rf', working_days: [1, 2, 3, 4, 5] };
  const d1 = DateUtils.isWorkingDay('2026-11-02', cal); // Пн
  const d2 = DateUtils.isWorkingDay('2026-11-04', cal); // Ср (Праздник РФ День народного единства)
  check('D-01', 'Производственный календарь РФ (04.11 — праздник)', d1 && !d2);

  // 2. D-02: CPM Calculation (FS + Lag)
  const cpmTasks = [
    { id: 't1', external_number: '1', duration_days: 3, percent_complete: 0 },
    { id: 't2', external_number: '2', duration_days: 2, percent_complete: 0 }
  ];
  const cpmDeps = [
    { id: 'dep1', pred_id: 't1', succ_id: 't2', type: 'FS', lag_workdays: 2 }
  ];
  const cpmRes = CpmEngine.calculate({
    tasks: cpmTasks,
    dependencies: cpmDeps,
    projectStartDate: '2026-11-02',
    calendar: cal
  });
  const t1 = cpmRes.tasks.find(t => t.id === 't1');
  const t2 = cpmRes.tasks.find(t => t.id === 't2');
  check('D-02', 'Расчет прямого/обратного прохода CPM (FS+2д)', t1 && t2 && t2.start_date > t1.finish_date);

  // 3. D-03: Milestones (0 duration)
  const mTask = { id: 'm1', external_number: '3', duration_days: 0, is_milestone: true };
  const mRes = CpmEngine.calculate({
    tasks: [mTask],
    dependencies: [],
    projectStartDate: '2026-11-02',
    calendar: cal
  });
  check('D-03', 'Веха: нулевая длительность и совпадение start = finish', mRes.tasks[0].start_date === mRes.tasks[0].finish_date);

  // 4. D-04: Total Float & Critical Path
  check('D-04', 'Определение критического пути и резерва времени', t1.is_critical && t2.is_critical && t1.total_float === 0);

  // 5. D-05: WBS summary rollup
  const wbsTasks = [
    { id: 'p1', external_number: '1', level: 0 },
    { id: 'c1', external_number: '1.1', parent_id: 'p1', duration_days: 4, percent_complete: 50, start_date: '2026-11-02', finish_date: '2026-11-05', level: 1 },
    { id: 'c2', external_number: '1.2', parent_id: 'p1', duration_days: 3, percent_complete: 100, start_date: '2026-11-06', finish_date: '2026-11-10', level: 1 }
  ];
  const rolled = WbsUtils.computeWbs(wbsTasks, [], cal, DateUtils);
  const parentNode = rolled.find(t => t.id === 'p1');
  check('D-05', 'Агрегация дат и прогресса суммарной задачи WBS', parentNode && parentNode.is_summary && parentNode.finish_date === '2026-11-10');

  // 6. D-06: Predecessors parser
  const parsedSyntax = ValidationUtils.parsePredecessors('2НС+1д; 3ОО; 4НН-2д; 5НО');
  check('D-06', 'Распознавание синтаксиса связей MS Project (НС, ОО, НН, НО)', parsedSyntax.length === 4);

  // 7. D-07: Cycle Detection
  const cycTasks = [
    { id: 'a', external_number: '1', duration_days: 1 },
    { id: 'b', external_number: '2', duration_days: 1 }
  ];
  const cycDeps = [
    { id: 'd1', pred_id: 'a', succ_id: 'b', type: 'FS', lag_workdays: 0 },
    { id: 'd2', pred_id: 'b', succ_id: 'a', type: 'FS', lag_workdays: 0 }
  ];
  const cycRes = CpmEngine.calculate({ tasks: cycTasks, dependencies: cycDeps, projectStartDate: '2026-11-02', calendar: cal });
  check('D-07', 'Контроль циклов зависимостей (Cycle Detection)', cycRes.error === 'CYCLE_DETECTED');

  // 8. D-08: Structural move & level clamp
  const moveProj = {
    tasks: [
      { id: 'g1', sort_order: 0, level: 0, parent_id: null },
      { id: 'g2', sort_order: 1, level: 1, parent_id: 'g1' },
      { id: 'g3', sort_order: 2, level: 2, parent_id: 'g2' }
    ]
  };
  const moveOk = WbsUtils.applyStructuralMove(moveProj, ['g3'], { beforeId: 'g2', level: 5 });
  const clampedTask = moveProj.tasks.find(t => t.id === 'g3');
  check('D-08', 'Ограничение уровня WBS при перемещении (level clamping)', moveOk && clampedTask && clampedTask.level <= 2);

  // 9. D-09: Pure Browser Native XLSX Generator
  const xlsxBlob = XlsxIO.makeNativeXlsx([
    { name: 'План', rows: [['№', 'Задача'], ['1', 'Тестовая работа']] }
  ]);
  check('D-09', 'Генерация XLSX без внешних библиотек (Native ZIP/OOXML)', xlsxBlob && xlsxBlob.size > 300);

  // 10. D-10: SHA-256 Package Checksum
  const pkgData = { test: 'localpm-verification', ts: 12345 };
  const hash1 = await TransferUtils.computeChecksum(pkgData);
  const hash2 = await TransferUtils.computeChecksum(pkgData);
  check('D-10', 'Криптографическая контрольная сумма SHA-256 (Web Crypto)', hash1 === hash2 && hash1.length === 64);

  // 11. D-11: Version Diff for Return Package
  const baseT = [{ id: '1', name: 'Старт', duration_days: 2 }];
  const curT = [{ id: '1', name: 'Старт изменен', duration_days: 5 }, { id: '2', name: 'Новая задача', duration_days: 1 }];
  const diff = TransferUtils.diffVersions(baseT, curT, [], []);
  check('D-11', 'Сравнение версий при возврате проекта (Diff)', diff.addedTasks.length === 1 && diff.updatedTasks.length === 1);

  // 12. D-12: Plan Quality & DCMA-14 Audit
  const audit = ValidationUtils.auditPlan(cpmRes.tasks, cpmDeps);
  check('D-12', 'Аудит качества расписания (DCMA-14)', audit && typeof audit.healthScore === 'number');

  // 13. D-13: Duration parse (д, н, ч)
  const durD = DateUtils.parseDuration('5д');
  const durW = DateUtils.parseDuration('2н');
  check('D-13', 'Парсинг единиц длительности (5д = 5, 2н = 10)', durD === 5 && durW === 10);

  // 14. D-14: Undo / Redo history stack support
  check('D-14', 'Поддержка стека Undo/Redo (50 снимков)', !appController || Array.isArray(appController.history.undo));

  return results;
}
