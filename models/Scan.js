const mongoose = require('mongoose');

const scanSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  url: {
    type: String,
    required: true,
    trim: true
  },
  issues: {
    type: Number,
    required: true,
    default: 0
  },
  // CRITICAL: This should be an array of objects, not a string!
  issueDetails: [{
    id: {
      type: Number,
      required: true
    },
    type: {
      type: String,
      required: true,
      enum: ['error', 'warning', 'notice']
    },
    severity: {
      type: String,
      required: true,
      enum: ['error', 'warning', 'notice']
    },
    selector: {
      type: String,
      required: true
    },
    message: {
      type: String,
      required: true
    },
    code: {
      type: String,
      required: true
    },
    context: {
      type: String,
      default: ''
    }
  }],
  score: {
    type: Number,
    required: true,
    min: 0,
    max: 100,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'running', 'completed', 'failed'],
    default: 'pending'
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  scanDuration: {
    type: Number, // in milliseconds
    required: true,
    default: 0
  },
  pageTitle: {
    type: String,
    default: 'Unknown'
  },
  pageDescription: {
    type: String,
    default: ''
  }
}, {
  timestamps: true // This adds createdAt and updatedAt automatically
});

// Add indexes for better query performance
scanSchema.index({ userId: 1, timestamp: -1 });
scanSchema.index({ url: 1 });
scanSchema.index({ status: 1 });

module.exports = mongoose.model('Scan', scanSchema);