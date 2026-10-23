/**
 * LocalPM - Date and Calendar calculations
 * Поддержка рабочих дней календаря проекта (Пн-Пт, РФ праздники, исключения)
 */

export const DateUtils = {
  // Format Date to YYYY-MM-DD
  formatISO(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  },

  // Format Date to Russian display format DD.MM.YYYY
  formatRU(date) {
    if (!date) return '';
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  },

  // Parse various date inputs (DD.MM.YYYY, YYYY-MM-DD, DD.MM, etc.)
  parseDate(str, defaultYear = new Date().getFullYear()) {
    if (!str) return null;
    if (str instanceof Date && !isNaN(str.getTime())) {
      return this.formatISO(str);
    }
    const s = String(str).trim();
    if (!s) return null;

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
        return s;
      }
    }

    // DD.MM.YYYY
    if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
      const [d, m, y] = s.split('.').map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
        return this.formatISO(dt);
      }
    }

    // DD.MM (without year)
    if (/^\d{1,2}\.\d{1,2}$/.test(s)) {
      const [d, m] = s.split('.').map(Number);
      const dt = new Date(defaultYear, m - 1, d);
      return this.formatISO(dt);
    }

    // Try standard Date.parse
    const timestamp = Date.parse(s);
    if (!isNaN(timestamp)) {
      return this.formatISO(new Date(timestamp));
    }

    return null;
  },

  // Standard Russian holidays (fixed dates MM-DD)
  // 1-8 янв, 23 фев, 8 мар, 1 мая, 9 мая, 12 июн, 4 ноя
  RF_DEFAULT_HOLIDAYS: [
    '01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
    '02-23', '03-08', '05-01', '05-09', '06-12', '11-04'
  ],

  // Check if date is working day according to calendar
  isWorkingDay(dateISO, calendar) {
    if (!dateISO) return false;
    const [y, m, d] = dateISO.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dayOfWeek = dt.getDay(); // 0 is Sunday, 1 is Monday ... 6 is Saturday

    const workingDays = (calendar && calendar.working_days) || [1, 2, 3, 4, 5];
    const exceptions = (calendar && calendar.exceptions) || [];

    // Check specific exception list (both added holidays or moved workdays)
    if (exceptions.includes(dateISO)) {
      // If it's in exceptions, it's a non-working day
      return false;
    }

    // If calendar has RF holidays enabled (or type == 'rf')
    if (calendar && calendar.type === 'rf') {
      const mmdd = `${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (this.RF_DEFAULT_HOLIDAYS.includes(mmdd)) {
        return false;
      }
    }

    return workingDays.includes(dayOfWeek);
  },

  // Next working day on or after dateISO
  ensureWorkingDay(dateISO, calendar, forward = true) {
    let cur = dateISO;
    while (!this.isWorkingDay(cur, calendar)) {
      cur = this.addCalendarDays(cur, forward ? 1 : -1);
    }
    return cur;
  },

  // Add calendar days to dateISO
  addCalendarDays(dateISO, days) {
    const [y, m, d] = dateISO.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    return this.formatISO(dt);
  },

  // Add working days (duration) to dateISO
  // Rules (4.14.1): Finish = Start + (Duration - 1) working days for Duration > 0.
  // For milestone (duration 0): Finish = Start
  addWorkingDays(startISO, durationDays, calendar) {
    if (durationDays <= 0) return startISO;
    let cur = this.ensureWorkingDay(startISO, calendar, true);
    let remaining = durationDays - 1; // if 1 day duration: same day if working

    while (remaining > 0) {
      cur = this.addCalendarDays(cur, 1);
      if (this.isWorkingDay(cur, calendar)) {
        remaining--;
      }
    }
    return cur;
  },

  // Shift by lag in working days (can be positive, negative, or 0)
  addLagWorkingDays(dateISO, lagDays, calendar) {
    if (!lagDays || lagDays === 0) return dateISO;
    let cur = dateISO;
    let remaining = Math.abs(lagDays);
    const step = lagDays > 0 ? 1 : -1;

    while (remaining > 0) {
      cur = this.addCalendarDays(cur, step);
      if (this.isWorkingDay(cur, calendar)) {
        remaining--;
      }
    }
    return cur;
  },

  // Calculate working days between start and finish inclusive
  diffWorkingDays(startISO, finishISO, calendar) {
    if (!startISO || !finishISO) return 0;
    if (startISO > finishISO) return 0;
    if (startISO === finishISO) {
      return this.isWorkingDay(startISO, calendar) ? 1 : 0;
    }

    let count = 0;
    let cur = startISO;
    while (cur <= finishISO) {
      if (this.isWorkingDay(cur, calendar)) {
        count++;
      }
      cur = this.addCalendarDays(cur, 1);
    }
    return count;
  },

  // Parse duration strings: "3д", "2н" (weeks=5 days), "4ч" (hours / 8), "5"
  parseDuration(str) {
    if (str === null || str === undefined || str === '') return 1;
    if (typeof str === 'number') return Math.max(0, str);
    const s = String(str).trim().toLowerCase();
    if (!s) return 1;

    // Check suffix
    if (s.endsWith('д') || s.endsWith('d')) {
      const val = parseFloat(s.slice(0, -1).replace(',', '.'));
      return isNaN(val) ? 1 : Math.max(0, val);
    }
    if (s.endsWith('н') || s.endsWith('w')) {
      const val = parseFloat(s.slice(0, -1).replace(',', '.'));
      return isNaN(val) ? 5 : Math.max(0, val * 5); // 5 working days in a week
    }
    if (s.endsWith('ч') || s.endsWith('h')) {
      const val = parseFloat(s.slice(0, -1).replace(',', '.'));
      return isNaN(val) ? 1 : Math.max(0, Math.round((val / 8) * 100) / 100);
    }

    const val = parseFloat(s.replace(',', '.'));
    return isNaN(val) ? 1 : Math.max(0, val);
  },

  formatDuration(days) {
    if (days === 0) return '0д';
    return `${days}д`;
  }
};
