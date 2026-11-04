/*
 * Copyright 2025 Sisters Inspire Sdn Bhd
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

/**
 * The closed sets of the `invoice` category (data/adapter-categories.json).
 *
 * The category declares each as a string with a full-match `pattern`, because
 * the writer maps whatever an accounting platform prints onto these labels
 * and the registry then refuses anything else. These enums are the same sets
 * as code, so a consumer switches over a type instead of repeating string
 * literals; a test pins each enum to its pattern, so the two cannot drift.
 */

/**
 * Where an invoice stands with MyInvois, the Malaysian e-invoice system, as
 * the accounting platform reports it.
 */
export enum MyInvoisStatus {
  /** Never sent to MyInvois: a plain invoice, not an e-invoice. */
  NotSubmitted = "not_submitted",
  /** Sent, and not yet validated or rejected. */
  Pending = "pending",
  /** Validated by MyInvois. Carries a UUID and a validation time. */
  Valid = "valid",
  /** Refused by MyInvois. */
  Rejected = "rejected",
}

/** How much of an invoice has been paid. */
export enum InvoiceSettlementStatus {
  /** Nothing paid. */
  Open = "open",
  /** Paid in part. */
  PartPaid = "part_paid",
  /** Paid in full. */
  Paid = "paid",
}
