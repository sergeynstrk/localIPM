/**
 * LocalPM - CPM Web Worker
 * Выполняет CPM-расчет в фоновом потоке для бесшовной работы интерфейса
 */

import { CpmEngine } from '../core/cpm.js';

self.onmessage = function (e) {
  const { type, payload, id } = e.data;

  if (type === 'CALCULATE_SCHEDULE') {
    try {
      const result = CpmEngine.calculate(payload);
      self.postMessage({ id, success: true, result });
    } catch (err) {
      self.postMessage({ id, success: false, error: err.message });
    }
  }
};
