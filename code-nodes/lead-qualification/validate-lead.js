// n8n Code node "Validate Lead" (Run Once for Each Item)
// Normalizes the raw webhook body into one clean lead object.
// Dialers and web forms send loose types ("yes", "$250", "602-555-0123"),
// so we coerce once here instead of in every downstream node.

const body = $json.body ?? {};
const errors = [];

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  const cleaned = str(v).replace(/[^0-9.]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const toBool = (v) => {
  if (typeof v === 'boolean') return v;
  const s = str(v).toLowerCase();
  if (['true', 'yes', 'y', '1', 'owner', 'homeowner'].includes(s)) return true;
  if (['false', 'no', 'n', '0', 'renter', 'rent'].includes(s)) return false;
  return null; // unknown: the model treats it as missing, not as "no"
};

const toUsPhone = (v) => {
  const digits = str(v).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return str(v);
};

const lead = {
  name: str(body.name),
  phone: toUsPhone(body.phone),
  email: str(body.email).toLowerCase(),
  address: str(body.address),
  monthly_electric_bill: toNumber(body.monthly_electric_bill),
  roof_age_years: toNumber(body.roof_age_years),
  homeowner: toBool(body.homeowner),
  notes: str(body.notes).slice(0, 2000),
};

if (!lead.name) errors.push('name is required');
if (!lead.phone && !lead.email) errors.push('phone or email is required');
if (lead.phone && !/^\+1\d{10}$/.test(lead.phone)) errors.push('phone must be a 10-digit US number');
if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) errors.push('email is not valid');

return {
  json: {
    ...lead,
    // Start of the run, for the telemetry node at the end. Epoch ms, because
    // it is subtracted, never displayed.
    t_start: Date.now(),
    is_valid: errors.length === 0,
    validation_errors: errors,
  },
};
