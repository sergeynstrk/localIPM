/**
 * LocalPM - Schema Definition & Migrations
 */

export const SCHEMA_VERSION = 1;

export const DB_CONFIG = {
  name: 'localpm',
  version: 1,
  stores: [
    {
      name: 'projects',
      keyPath: 'id',
      indexes: [
        { name: 'updated_at', keyPath: 'updated_at' },
        { name: 'origin_id', keyPath: 'origin_id' }
      ]
    },
    {
      name: 'tasks',
      keyPath: 'id',
      indexes: [
        { name: 'project_id', keyPath: 'project_id' },
        { name: 'parent_id', keyPath: 'parent_id' },
        { name: 'sort_order', keyPath: 'sort_order' }
      ]
    },
    {
      name: 'dependencies',
      keyPath: 'id',
      indexes: [
        { name: 'project_id', keyPath: 'project_id' },
        { name: 'pred_id', keyPath: 'pred_id' },
        { name: 'succ_id', keyPath: 'succ_id' }
      ]
    },
    {
      name: 'calendars',
      keyPath: 'id',
      indexes: []
    },
    {
      name: 'transfers',
      keyPath: 'id',
      indexes: [
        { name: 'project_id', keyPath: 'project_id' },
        { name: 'ts', keyPath: 'ts' }
      ]
    },
    {
      name: 'settings',
      keyPath: 'key',
      indexes: []
    },
    {
      name: 'meta',
      keyPath: 'key',
      indexes: []
    }
  ]
};
