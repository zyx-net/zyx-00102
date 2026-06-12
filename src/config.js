const path = require('path');

module.exports = {
  port: process.env.PORT || 3000,
  dataDir: path.join(__dirname, '..', 'data'),
  temperature: {
    min: 2.0,
    max: 8.0,
    maxGapMinutes: 30
  },
  roles: {
    RECEIVER: 'receiver',
    PHARMACIST: 'pharmacist',
    QUALITY_MANAGER: 'quality_manager'
  },
  status: {
    PENDING_REVIEW: 'pending_review',
    QUARANTINED: 'quarantined',
    RELEASED: 'released',
    REJECTED: 'rejected',
    VOIDED: 'voided'
  },
  users: [
    { id: 'receiver01', name: '张收货', role: 'receiver' },
    { id: 'pharmacist01', name: '李药师', role: 'pharmacist' },
    { id: 'quality01', name: '王质管', role: 'quality_manager' }
  ]
};
