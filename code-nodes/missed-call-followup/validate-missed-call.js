// n8n Code node "Validate Missed Call" (Run Once for Each Item)
// Normalizes the dialer payload and creates a followup_id that ties together
// every SMS attempt and Sheet row for this one missed call.

const body = $json.body ?? {};
const errors = [];
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

const digits = str(body.phone).replace(/\D/g, '');
const phone =
  digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith('1') ? `+${digits}` : '';
if (!phone) errors.push('phone must be a 10-digit US number');

const contactName = str(body.contact_name);
const firstName = contactName.split(/\s+/)[0] ?? '';

let missedAt = new Date(str(body.missed_at));
if (!str(body.missed_at) || Number.isNaN(missedAt.getTime())) {
  errors.push('missed_at must be an ISO 8601 timestamp');
  missedAt = null;
}

const campaign = str(body.campaign);
// Internal campaign codes ("AZ-FB-SOLAR-Q3") must never appear in a text to a
// homeowner, so the model only gets a plain service label derived here.
const c = campaign.toLowerCase();
const serviceInterest =
  c.includes('roof') && c.includes('solar') ? 'solar and roofing'
  : c.includes('roof') ? 'roofing'
  : c.includes('solar') ? 'solar'
  : 'solar and roofing';

return {
  json: {
    // Start of the run, for the telemetry node. Epoch ms.
    t_start: Date.now(),
    followup_id: `mc-${$execution.id}`,
    contact_name: contactName,
    first_name: firstName,
    phone,
    missed_at: missedAt ? missedAt.toISOString() : null,
    campaign,
    service_interest: serviceInterest,
    is_valid: errors.length === 0,
    validation_errors: errors,
  },
};
