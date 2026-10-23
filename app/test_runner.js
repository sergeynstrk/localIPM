import { CpmEngine } from './core/cpm.js';
import { DateUtils } from './core/dates.js';
import { ValidationUtils } from './core/validation.js';
import { WbsUtils } from './core/wbs.js';

console.log('=== ЗАПУСК ПРОВЕРОЧНЫХ ТЕСТОВ LOCALPM (ТЗ v2.1) ===\n');

// 1. AT-08: Cycle detection
console.log('1. Проверка обнаружения циклов (AT-08)...');
const cycleTasks = [
  { id: '1', external_number: '1', duration_days: 2 },
  { id: '2', external_number: '2', duration_days: 3 }
];
const cycleDeps = [
  { id: 'd1', pred_id: '1', succ_id: '2', type: 'FS', lag_workdays: 0 },
  { id: 'd2', pred_id: '2', succ_id: '1', type: 'FS', lag_workdays: 0 }
];
let cycleCaught = false;
const resCycle = CpmEngine.calculate({
  tasks: cycleTasks,
  dependencies: cycleDeps,
  projectStartDate: '2026-11-01',
  calendar: { type: 'rf', working_days: [1,2,3,4,5] }
});
if (resCycle.error === 'CYCLE_DETECTED') {
  cycleCaught = true;
  console.log('   УСПЕШНО: Обнаружен цикл ->', resCycle.cyclePath.join(' ➔ '));
}
if (!cycleCaught) throw new Error('Ошибка: цикл не был обнаружен!');

// 2. AT-04: Синтаксис связей
console.log('\n2. Проверка распознавания связей MS Project (AT-04)...');
const samplePreds = '3НС+2д, 4ОО-1д, 5НН, 6НО';
const parsed = ValidationUtils.parsePredecessors(samplePreds);
console.log('   Распознано связей:', parsed.length);
if (parsed.length !== 4) throw new Error('Некорректное число связей!');
console.log('   УСПЕШНО: Связи и лаги распознаны:', JSON.stringify(parsed));

// 3. AT-06: Вехи
console.log('\n3. Проверка вех (AT-06)...');
const milestoneTask = { id: 'm1', external_number: '1', name: 'Приёмка ТЗ', duration_days: 0, is_milestone: true };
const resMilestone = CpmEngine.calculate({
  tasks: [milestoneTask],
  dependencies: [],
  projectStartDate: '2026-11-02',
  calendar: { type: 'rf', working_days: [1,2,3,4,5] }
});
if (resMilestone.tasks[0].finish_date !== resMilestone.tasks[0].start_date) {
  throw new Error('Ошибка: у вехи даты начала и окончания должны совпадать!');
}
console.log('   УСПЕШНО: Веха рассчитана, start = finish =', resMilestone.tasks[0].start_date);

// 4. AT-11: Стресс-тест масштабируемости (1 000 задач, 500 связей)
console.log('\n4. Стресс-тест 1 000 задач и 500 связей (AT-11)...');
const scaleTasks = [];
const scaleDeps = [];
for (let i = 1; i <= 1000; i++) {
  scaleTasks.push({ id: 't' + i, external_number: String(i), name: 'Задача ' + i, duration_days: (i % 5) + 1, level: 0 });
  if (i > 1 && i <= 500) {
    scaleDeps.push({ id: 'd' + i, pred_id: 't' + (i - 1), succ_id: 't' + i, type: 'FS', lag_workdays: 0 });
  }
}
const t0 = Date.now();
const resScale = CpmEngine.calculate({
  tasks: scaleTasks,
  dependencies: scaleDeps,
  projectStartDate: '2026-11-01',
  calendar: { type: 'rf', working_days: [1,2,3,4,5] }
});
const dur = Date.now() - t0;
console.log(`   УСПЕШНО: 1 000 задач рассчитано за ${dur} мс (требование: <= 1000 мс)`);
if (dur > 1000) throw new Error('Превышен лимит времени выполнения CPM!');

console.log('\n=== ВСЕ ТЕСТЫ УСПЕШНО ПРОЙДЕНЫ ===');
