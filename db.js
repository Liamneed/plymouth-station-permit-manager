import "dotenv/config";
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
export const databaseEnabled = Boolean(DATABASE_URL);
export const pool = databaseEnabled ? new Pool({
  connectionString: DATABASE_URL,
  ssl: String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true'
    ? { rejectUnauthorized: false }
    : false,
  max: Math.max(2, Number(process.env.DATABASE_POOL_MAX || 10)),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
}) : null;

export const normaliseReg = value =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

export const displayReg = value => {
  const reg = normaliseReg(value);
  return reg.length === 7
    ? `${reg.slice(0, 4)} ${reg.slice(4)}`
    : reg;
};

export const hashApiKey = value =>
  crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');

export async function initDatabase() {
  if (!pool) return { enabled: false };

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS operators (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      code text UNIQUE,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS vehicles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      registration text NOT NULL UNIQUE,
      display_registration text NOT NULL,
      plate_number text,
      operator_id uuid REFERENCES operators(id),
      needacab boolean NOT NULL DEFAULT false,
      autocab_vehicle_id text,
      callsign text,
      make text,
      model text,
      active boolean NOT NULL DEFAULT true,
      suspended boolean NOT NULL DEFAULT false,
      notes text,
      source text NOT NULL DEFAULT 'manual',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_vehicles_plate
      ON vehicles(plate_number);

    CREATE INDEX IF NOT EXISTS idx_vehicles_callsign
      ON vehicles(callsign);

    CREATE TABLE IF NOT EXISTS permits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vehicle_id uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
      permit_number text,
      permit_type text NOT NULL DEFAULT 'Plymouth Taxi Permit',
      valid_from date,
      expires_on date,
      status_override text,
      suspended boolean NOT NULL DEFAULT false,
      notes text,
      is_current boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_current_permit_vehicle
      ON permits(vehicle_id)
      WHERE is_current = true;

    CREATE INDEX IF NOT EXISTS idx_permits_expiry
      ON permits(expires_on);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id bigserial PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      actor text NOT NULL DEFAULT 'system',
      action text NOT NULL,
      entity_type text NOT NULL,
      entity_id text,
      registration text,
      before_data jsonb,
      after_data jsonb,
      ip_address text,
      user_agent text,
      request_id text
    );

    CREATE INDEX IF NOT EXISTS idx_audit_occurred
      ON audit_logs(occurred_at DESC);

    CREATE INDEX IF NOT EXISTS idx_audit_registration
      ON audit_logs(registration);

    CREATE TABLE IF NOT EXISTS system_logs (
      id bigserial PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      level text NOT NULL DEFAULT 'info',
      category text NOT NULL DEFAULT 'application',
      message text NOT NULL,
      method text,
      path text,
      status_code integer,
      duration_ms integer,
      ip_address text,
      user_agent text,
      request_id text,
      metadata jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_system_logs_occurred
      ON system_logs(occurred_at DESC);

    CREATE INDEX IF NOT EXISTS idx_system_logs_category
      ON system_logs(category);

    CREATE TABLE IF NOT EXISTS api_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      key_prefix text NOT NULL,
      key_hash text NOT NULL UNIQUE,
      scopes text[] NOT NULL DEFAULT ARRAY['permit:read']::text[],
      active boolean NOT NULL DEFAULT true,
      expires_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS permit_notifications (
      id bigserial PRIMARY KEY,
      permit_id uuid NOT NULL REFERENCES permits(id) ON DELETE CASCADE,
      alert_days integer NOT NULL,
      recipient text NOT NULL,
      sent_at timestamptz NOT NULL DEFAULT now(),
      success boolean NOT NULL,
      error_message text,
      UNIQUE(permit_id, alert_days, recipient)
    );

    ALTER TABLE operators ADD COLUMN IF NOT EXISTS integration_type text NOT NULL DEFAULT 'manual';
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS external_company_id text;
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS contact_name text;
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS contact_email text;
    ALTER TABLE operators ADD COLUMN IF NOT EXISTS contact_phone text;

    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS integration_provider text;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS external_vehicle_id text;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS sync_status text NOT NULL DEFAULT 'not_synced';
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS sync_message text;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS last_external_check_at timestamptz;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS last_external_sync_at timestamptz;
    ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS external_snapshot jsonb;

    CREATE INDEX IF NOT EXISTS idx_vehicles_external_vehicle
      ON vehicles(integration_provider, external_vehicle_id);

    CREATE TABLE IF NOT EXISTS evidence_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      reference text NOT NULL UNIQUE,
      vehicle_id uuid REFERENCES vehicles(id),
      registration text NOT NULL,
      anpr_provider text,
      anpr_confidence numeric(6,3),
      permit_status_snapshot text,
      permit_expiry_snapshot date,
      captured_at timestamptz NOT NULL,
      latitude numeric(10,7),
      longitude numeric(10,7),
      gps_accuracy numeric(10,2),
      location_text text,
      notes text,
      original_path text,
      stamped_path text,
      original_sha256 text,
      stamped_sha256 text,
      email_status text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  return { enabled: true };
}

export async function dbStatus() {
  if (!pool) {
    return {
      enabled: false,
      connected: false
    };
  }

  const { rows } = await pool.query(
    'SELECT now() AS now, current_database() AS database'
  );

  return {
    enabled: true,
    connected: true,
    ...rows[0]
  };
}

export function permitState(
  expiresOn,
  suspended = false,
  override = null
) {
  if (override) {
    return {
      key: override,
      label: override.replaceAll('_', ' ')
    };
  }

  if (suspended) {
    return {
      key: 'suspended',
      label: 'Suspended'
    };
  }

  if (!expiresOn) {
    return {
      key: 'missing',
      label: 'No permit date',
      daysRemaining: null
    };
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const exp = new Date(
    `${String(expiresOn).slice(0, 10)}T00:00:00`
  );

  const days = Math.round((exp - now) / 86400000);

  if (days < 0) {
    return {
      key: 'expired',
      label: `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`,
      daysRemaining: days
    };
  }

  if (days === 0) {
    return {
      key: 'due',
      label: 'Expires today',
      daysRemaining: 0
    };
  }

  if (days <= 30) {
    return {
      key: 'due',
      label: `Due in ${days} day${days === 1 ? '' : 's'}`,
      daysRemaining: days
    };
  }

  return {
    key: 'valid',
    label: 'Valid permit',
    daysRemaining: days
  };
}

export async function listPermits({
  search = '',
  status = '',
  limit = 200,
  offset = 0
} = {}) {
  if (!pool) return [];

  const params = [];
  const where = [];

  if (search) {
    params.push(
      `%${normaliseReg(search)}%`,
      `%${search}%`
    );

    where.push(
      `(v.registration ILIKE $${params.length - 1}
        OR v.plate_number ILIKE $${params.length}
        OR v.callsign ILIKE $${params.length})`
    );
  }

  const sql = `
    SELECT
      v.*,
      o.name AS operator_name,
      p.id AS permit_id,
      p.permit_number,
      p.permit_type,
      p.valid_from,
      p.expires_on,
      p.status_override,
      p.suspended AS permit_suspended,
      p.notes AS permit_notes,
      p.updated_at AS permit_updated_at
    FROM vehicles v
    LEFT JOIN operators o
      ON o.id = v.operator_id
    LEFT JOIN permits p
      ON p.vehicle_id = v.id
     AND p.is_current = true
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY v.registration
    LIMIT ${Math.min(Number(limit) || 200, 1000)}
    OFFSET ${Math.max(Number(offset) || 0, 0)}
  `;

  const { rows } = await pool.query(sql, params);

  return rows
    .map(row => ({
      ...row,
      permitStatus: permitState(
        row.expires_on,
        row.permit_suspended || row.suspended,
        row.status_override
      )
    }))
    .filter(row =>
      !status || row.permitStatus.key === status
    );
}

export async function getPermitByRegistration(registration) {
  const reg = normaliseReg(registration);

  if (!pool || !reg) return null;

  const { rows } = await pool.query(
    `
      SELECT
        v.*,
        o.name AS operator_name,
        p.id AS permit_id,
        p.permit_number,
        p.permit_type,
        p.valid_from,
        p.expires_on,
        p.status_override,
        p.suspended AS permit_suspended,
        p.notes AS permit_notes,
        p.updated_at AS permit_updated_at
      FROM vehicles v
      LEFT JOIN operators o
        ON o.id = v.operator_id
      LEFT JOIN permits p
        ON p.vehicle_id = v.id
       AND p.is_current = true
      WHERE v.registration = $1
    `,
    [reg]
  );

  if (!rows[0]) return null;

  return {
    ...rows[0],
    permitStatus: permitState(
      rows[0].expires_on,
      rows[0].permit_suspended || rows[0].suspended,
      rows[0].status_override
    )
  };
}

export async function upsertPermitRecord(
  input,
  context = {}
) {
  if (!pool) {
    throw new Error('Database is not configured.');
  }

  const reg = normaliseReg(input.registration);

  if (!reg) {
    throw new Error('Registration is required.');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const before = await client.query(
      `
        SELECT
          v.*,
          p.id AS permit_id,
          p.expires_on,
          p.valid_from,
          p.permit_number,
          p.notes AS permit_notes
        FROM vehicles v
        LEFT JOIN permits p
          ON p.vehicle_id = v.id
         AND p.is_current = true
        WHERE v.registration = $1
        FOR UPDATE OF v
      `,
      [reg]
    );

    let vehicleId;

    if (!before.rows[0]) {
      const operatorName = String(
        input.operator || 'Independent'
      ).trim();

      const operatorResult = await client.query(
        `
          INSERT INTO operators(name)
          VALUES($1)
          ON CONFLICT(name)
          DO UPDATE SET updated_at = now()
          RETURNING id
        `,
        [operatorName]
      );

      const vehicleResult = await client.query(
        `
          INSERT INTO vehicles(
            registration,
            display_registration,
            plate_number,
            operator_id,
            needacab,
            callsign,
            notes,
            source
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
          RETURNING id
        `,
        [
          reg,
          displayReg(reg),
          input.plateNumber || null,
          operatorResult.rows[0].id,
          Boolean(input.needACab),
          input.callsign || null,
          input.vehicleNotes || null,
          input.source || 'manual'
        ]
      );

      vehicleId = vehicleResult.rows[0].id;
    } else {
      vehicleId = before.rows[0].id;

      await client.query(
        `
          UPDATE vehicles
          SET
            plate_number = COALESCE($2, plate_number),
            callsign = COALESCE($3, callsign),
            needacab = COALESCE($4, needacab),
            notes = COALESCE($5, notes),
            suspended = COALESCE($6, suspended),
            updated_at = now()
          WHERE id = $1
        `,
        [
          vehicleId,
          input.plateNumber ?? null,
          input.callsign ?? null,
          input.needACab ?? null,
          input.vehicleNotes ?? null,
          input.vehicleSuspended ?? null
        ]
      );
    }

    await client.query(
      `
        INSERT INTO permits(
          vehicle_id,
          permit_number,
          permit_type,
          valid_from,
          expires_on,
          suspended,
          notes,
          is_current
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,true)
        ON CONFLICT (vehicle_id)
        WHERE is_current = true
        DO UPDATE SET
          permit_number = EXCLUDED.permit_number,
          permit_type = EXCLUDED.permit_type,
          valid_from = EXCLUDED.valid_from,
          expires_on = EXCLUDED.expires_on,
          suspended = EXCLUDED.suspended,
          notes = EXCLUDED.notes,
          updated_at = now()
      `,
      [
        vehicleId,
        input.permitNumber || null,
        input.permitType || 'Plymouth Taxi Permit',
        input.validFrom || null,
        input.expiresOn || null,
        Boolean(input.permitSuspended),
        input.permitNotes || null
      ]
    );

    const after = await client.query(
      `
        SELECT
          v.*,
          p.id AS permit_id,
          p.expires_on,
          p.valid_from,
          p.permit_number,
          p.notes AS permit_notes
        FROM vehicles v
        LEFT JOIN permits p
          ON p.vehicle_id = v.id
         AND p.is_current = true
        WHERE v.id = $1
      `,
      [vehicleId]
    );

    await client.query(
      `
        INSERT INTO audit_logs(
          actor,
          action,
          entity_type,
          entity_id,
          registration,
          before_data,
          after_data,
          ip_address,
          user_agent,
          request_id
        )
        VALUES($1,$2,'permit',$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        context.actor || 'admin',
        before.rows[0]
          ? 'permit.updated'
          : 'permit.created',
        vehicleId,
        reg,
        before.rows[0] || null,
        after.rows[0],
        context.ip || null,
        context.userAgent || null,
        context.requestId || null
      ]
    );

    await client.query('COMMIT');

    return getPermitByRegistration(reg);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function writeSystemLog(entry) {
  if (!pool) return;

  try {
    await pool.query(
      `
        INSERT INTO system_logs(
          level,
          category,
          message,
          method,
          path,
          status_code,
          duration_ms,
          ip_address,
          user_agent,
          request_id,
          metadata
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        entry.level || 'info',
        entry.category || 'http',
        entry.message || '',
        entry.method || null,
        entry.path || null,
        entry.statusCode || null,
        entry.durationMs || null,
        entry.ip || null,
        entry.userAgent || null,
        entry.requestId || null,
        entry.metadata || null
      ]
    );
  } catch {
    // Logging must not interrupt the main request.
  }
}

export async function listLogs({
  type = 'system',
  search = '',
  level = '',
  limit = 200,
  offset = 0
} = {}) {
  if (!pool) return [];

  const table =
    type === 'audit'
      ? 'audit_logs'
      : 'system_logs';

  const params = [];
  const where = [];

  if (search) {
    params.push(`%${search}%`);

    where.push(
      type === 'audit'
        ? `(action ILIKE $1
           OR registration ILIKE $1
           OR actor ILIKE $1)`
        : `(message ILIKE $1
           OR path ILIKE $1
           OR category ILIKE $1)`
    );
  }

  if (level && type !== 'audit') {
    params.push(level);
    where.push(`level = $${params.length}`);
  }

  const { rows } = await pool.query(
    `
      SELECT *
      FROM ${table}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC
      LIMIT ${Math.min(Number(limit) || 200, 1000)}
      OFFSET ${Math.max(Number(offset) || 0, 0)}
    `,
    params
  );

  return rows;
}

export async function createApiKey(
  name,
  scopes = ['permit:read'],
  expiresAt = null
) {
  if (!pool) {
    throw new Error('Database is not configured.');
  }

  const token =
    `ppm_${crypto.randomBytes(28).toString('base64url')}`;

  await pool.query(
    `
      INSERT INTO api_keys(
        name,
        key_prefix,
        key_hash,
        scopes,
        expires_at
      )
      VALUES($1,$2,$3,$4,$5)
    `,
    [
      name,
      token.slice(0, 12),
      hashApiKey(token),
      scopes,
      expiresAt || null
    ]
  );

  return {
    token,
    prefix: token.slice(0, 12),
    name,
    scopes
  };
}

export async function authenticateApiKey(
  token,
  requiredScope = 'permit:read'
) {
  if (!pool || !token) return null;

  const { rows } = await pool.query(
    `
      SELECT *
      FROM api_keys
      WHERE key_hash = $1
        AND active = true
        AND (
          expires_at IS NULL
          OR expires_at > now()
        )
    `,
    [hashApiKey(token)]
  );

  const key = rows[0];

  if (
    !key ||
    !key.scopes.includes(requiredScope)
  ) {
    return null;
  }

  pool
    .query(
      'UPDATE api_keys SET last_used_at = now() WHERE id = $1',
      [key.id]
    )
    .catch(() => {});

  return key;
}

export async function seedFromJson(records = []) {
  if (
    !pool ||
    !Array.isArray(records) ||
    records.length === 0
  ) {
    return {
      imported: 0,
      failed: 0,
      errors: []
    };
  }

  const countResult = await pool.query(
    'SELECT count(*)::int AS count FROM vehicles'
  );

  if (countResult.rows[0].count > 0) {
    return {
      imported: 0,
      failed: 0,
      errors: [],
      skipped: true,
      reason: 'Database already contains vehicles.'
    };
  }

  let imported = 0;
  let failed = 0;
  const errors = [];

  for (const record of records) {
    try {
      await upsertPermitRecord(
        {
          registration: record.registration,
          plateNumber:
            record.plateNumber ||
            null,
          permitNumber:
            record.permitNumber ||
            record.plateNumber ||
            null,
          operator:
            record.operator ||
            'Plymouth Register',
          validFrom:
            record.validFrom ||
            record.startsOn ||
            null,
          expiresOn:
            record.expiresOn ||
            record.permitExpiryDate ||
            null,
          needACab:
            Boolean(record.needACab),
          callsign:
            record.callsign ||
            null,
          vehicleNotes:
            record.vehicleNotes ||
            null,
          permitNotes:
            record.permitNotes ||
            null,
          source:
            'json-seed'
        },
        {
          actor: 'migration'
        }
      );

      imported += 1;
    } catch (error) {
      failed += 1;

      const registration =
        record?.registration ||
        'unknown';

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      errors.push({
        registration,
        message
      });

      console.error(
        `Permit seed import failed for ${registration}:`,
        message
      );
    }
  }

  return {
    imported,
    failed,
    errors
  };
}

export async function duePermitAlerts(
  alertDays = [30, 14, 7, 1, 0],
  recipient = ''
) {
  if (!pool) return [];

  const { rows } = await pool.query(
    `
      SELECT
        p.id AS permit_id,
        p.expires_on,
        v.registration,
        v.display_registration,
        v.plate_number,
        v.callsign,
        o.name AS operator_name,
        (p.expires_on - CURRENT_DATE)::int
          AS days_remaining
      FROM permits p
      JOIN vehicles v
        ON v.id = p.vehicle_id
      LEFT JOIN operators o
        ON o.id = v.operator_id
      WHERE p.is_current = true
        AND p.suspended = false
        AND v.suspended = false
        AND p.expires_on IS NOT NULL
        AND (
          p.expires_on - CURRENT_DATE
        )::int = ANY($1::int[])
        AND NOT EXISTS (
          SELECT 1
          FROM permit_notifications n
          WHERE n.permit_id = p.id
            AND n.alert_days = (
              p.expires_on - CURRENT_DATE
            )::int
            AND n.recipient = $2
            AND n.success = true
        )
      ORDER BY
        p.expires_on,
        v.registration
    `,
    [
      alertDays,
      recipient
    ]
  );

  return rows;
}

export async function recordPermitNotification({
  permitId,
  alertDays,
  recipient,
  success,
  errorMessage = null
}) {
  if (!pool) return;

  await pool.query(
    `
      INSERT INTO permit_notifications(
        permit_id,
        alert_days,
        recipient,
        success,
        error_message
      )
      VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(
        permit_id,
        alert_days,
        recipient
      )
      DO UPDATE SET
        sent_at = now(),
        success = EXCLUDED.success,
        error_message = EXCLUDED.error_message
    `,
    [
      permitId,
      alertDays,
      recipient,
      success,
      errorMessage
    ]
  );
}

export async function notificationHistory(limit = 200) {
  if (!pool) return [];

  const { rows } = await pool.query(
    `
      SELECT
        n.*,
        v.registration,
        v.display_registration,
        p.expires_on
      FROM permit_notifications n
      JOIN permits p
        ON p.id = n.permit_id
      JOIN vehicles v
        ON v.id = p.vehicle_id
      ORDER BY n.sent_at DESC
      LIMIT $1
    `,
    [
      Math.min(
        Number(limit) || 200,
        1000
      )
    ]
  );

  return rows;
}


export async function updateVehicleSyncState(registration, state = {}, context = {}) {
  if (!pool) throw new Error('Database is not configured.');
  const reg = normaliseReg(registration);
  if (!reg) throw new Error('Registration is required.');

  const before = await getPermitByRegistration(reg);
  if (!before) throw new Error('Vehicle not found.');

  const { rows } = await pool.query(
    `UPDATE vehicles
       SET integration_provider = COALESCE($2, integration_provider),
           external_vehicle_id = COALESCE($3, external_vehicle_id),
           sync_status = COALESCE($4, sync_status),
           sync_message = $5,
           last_external_check_at = CASE WHEN $6::boolean THEN now() ELSE last_external_check_at END,
           last_external_sync_at = CASE WHEN $7::boolean THEN now() ELSE last_external_sync_at END,
           external_snapshot = COALESCE($8::jsonb, external_snapshot),
           updated_at = now()
     WHERE registration = $1
     RETURNING *`,
    [
      reg,
      state.provider || null,
      state.externalVehicleId ? String(state.externalVehicleId) : null,
      state.status || null,
      state.message ?? null,
      Boolean(state.checked),
      Boolean(state.synced),
      state.snapshot ? JSON.stringify(state.snapshot) : null,
    ]
  );

  const after = await getPermitByRegistration(reg);
  await pool.query(
    `INSERT INTO audit_logs(actor,action,entity_type,entity_id,registration,before_data,after_data,ip_address,user_agent,request_id)
     VALUES($1,$2,'vehicle_sync',$3,$4,$5,$6,$7,$8,$9)`,
    [
      context.actor || 'system',
      state.action || 'vehicle.sync_state_changed',
      rows[0]?.id || before.id,
      reg,
      before,
      after,
      context.ip || null,
      context.userAgent || null,
      context.requestId || null,
    ]
  );
  return after;
}

export async function listIntegrationOperators() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT o.*,
            count(v.id)::int AS vehicle_count,
            count(v.id) FILTER (WHERE v.sync_status='synced')::int AS synced_count,
            count(v.id) FILTER (WHERE v.sync_status IN ('failed','mismatch','pending'))::int AS attention_count
       FROM operators o
       LEFT JOIN vehicles v ON v.operator_id=o.id
      GROUP BY o.id
      ORDER BY o.name`
  );
  return rows;
}
