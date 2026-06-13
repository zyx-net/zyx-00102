const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
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
  dispositionStatus: {
    DRAFT: 'draft',
    PENDING_APPROVAL: 'pending_approval',
    RETURNED_FOR_SUPPLEMENT: 'returned_for_supplement',
    APPROVED: 'approved',
    CLOSED: 'closed'
  },
  deviationLevel: {
    MINOR: 'minor',
    MODERATE: 'moderate',
    MAJOR: 'major',
    CRITICAL: 'critical'
  },
  dispositionDecision: {
    RELEASE: 'release',
    REJECT: 'reject',
    RETURN_FOR_SUPPLEMENT: 'return_for_supplement'
  },
  supplementStatus: {
    PENDING: 'pending',
    SUBMITTED: 'submitted'
  },
  calibrationStatus: {
    ACTIVE: 'active',
    VOIDED: 'voided'
  },
  deviceType: {
    THERMOMETER: 'thermometer',
    DATA_LOGGER: 'data_logger'
  },
  calibrationPermissions: {
    RECEIVER: ['view', 'reference'],
    PHARMACIST: ['view', 'reference'],
    QUALITY_MANAGER: ['view', 'reference', 'create', 'update', 'void', 'change_expiry']
  },
  inspectionStatus: {
    PENDING: 'pending',
    SUBMITTED: 'submitted',
    APPROVED: 'approved',
    RETURNED: 'returned'
  },
  inspectionPermissions: {
    RECEIVER: ['view'],
    PHARMACIST: ['view', 'submit_result'],
    QUALITY_MANAGER: ['view', 'create', 'approve', 'return']
  },
  users: [
    { id: 'receiver01', name: '张收货', role: 'receiver' },
    { id: 'pharmacist01', name: '李药师', role: 'pharmacist' },
    { id: 'quality01', name: '王质管', role: 'quality_manager' }
  ]
};
