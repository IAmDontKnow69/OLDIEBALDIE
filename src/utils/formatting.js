// Time formatting utilities

const TZ_MAP = {
  'GMT': 'Europe/London',
  'CET': 'Europe/Paris',
  'EST': 'America/New_York',
  'CST': 'America/Chicago',
  'PST': 'America/Los_Angeles'
};

function formatMatchTime(scheduledAt, tzLabel) {
  // scheduledAt: ISO string or timestamp
  const date = new Date(scheduledAt);
  const localTz = TZ_MAP[tzLabel] || 'UTC';

  const localOpts = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: localTz };
  const gmtOpts = { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'UTC' };

  const local = new Intl.DateTimeFormat('en-US', localOpts).format(date);
  const gmt = new Intl.DateTimeFormat('en-US', gmtOpts).format(date);

  return `${local} (${tzLabel}) | ${gmt} GMT`;
}

module.exports = { formatMatchTime };
