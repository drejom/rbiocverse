/**
 * DateRangeSelector - Shared date range control for analytics
 */
import React from 'react';

const DATE_RANGES = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
];

export function DateRangeSelector({ value, onChange, ranges = DATE_RANGES }) {
  return (
    <div className="date-range-selector">
      {ranges.map(range => (
        <button
          key={range.value}
          className={`date-range-btn ${value === range.value ? 'active' : ''}`}
          onClick={() => onChange(range.value)}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
