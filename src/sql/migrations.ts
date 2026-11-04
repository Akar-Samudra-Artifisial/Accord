import { migrationRunner } from '@forge/sql';

/**
 * Forge SQL (MySQL-compatible) schema for Accord. Migrations are append-only:
 * never edit an applied statement, add a new versioned entry instead.
 */
export const MIGRATIONS: ReadonlyArray<{ name: string; statement: string }> = [
  {
    name: 'v001_create_teams',
    statement: `CREATE TABLE IF NOT EXISTS teams (
      id VARCHAR(64) PRIMARY KEY,
      team_key VARCHAR(32) NOT NULL UNIQUE,
      name VARCHAR(255) NOT NULL,
      jira_project_key VARCHAR(32) NOT NULL,
      board_id BIGINT NULL,
      lead_account_id VARCHAR(128) NULL,
      atlassian_team_id VARCHAR(128) NULL,
      charter_page_id VARCHAR(64) NULL
    )`,
  },
  {
    name: 'v002_create_charters',
    statement: `CREATE TABLE IF NOT EXISTS charters (
      team_id VARCHAR(64) PRIMARY KEY,
      page_id VARCHAR(64) NOT NULL,
      page_version INT NOT NULL,
      valid BOOLEAN NOT NULL DEFAULT FALSE,
      missing_fields JSON NULL,
      priorities JSON NULL,
      red_lines JSON NULL,
      shiftable JSON NULL,
      max_external_share DECIMAL(4,3) NULL,
      response_days INT NULL,
      approvers JSON NULL,
      escalation_contact VARCHAR(128) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  {
    name: 'v003_create_throughput_samples',
    statement: `CREATE TABLE IF NOT EXISTS throughput_samples (
      team_id VARCHAR(64) NOT NULL,
      sprint_id VARCHAR(64) NOT NULL,
      sprint_name VARCHAR(255) NOT NULL,
      completed_count INT NOT NULL,
      end_date DATE NOT NULL,
      source VARCHAR(16) NOT NULL DEFAULT 'jira',
      PRIMARY KEY (team_id, sprint_id),
      CHECK (source IN ('jira', 'simulated'))
    )`,
  },
  {
    name: 'v004_create_requests',
    statement: `CREATE TABLE IF NOT EXISTS requests (
      id VARCHAR(64) PRIMARY KEY,
      requester_team_id VARCHAR(64) NOT NULL,
      provider_team_id VARCHAR(64) NOT NULL,
      source_issue_key VARCHAR(64) NOT NULL,
      title VARCHAR(255) NOT NULL,
      size CHAR(1) NOT NULL,
      size_corrected CHAR(1) NULL,
      min_size INT NULL,
      needed_by DATE NOT NULL,
      epic_key VARCHAR(64) NULL,
      cost_class VARCHAR(16) NOT NULL,
      status VARCHAR(32) NOT NULL,
      created_by VARCHAR(128) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_requests_provider_status (provider_team_id, status),
      INDEX idx_requests_requester (requester_team_id)
    )`,
  },
  {
    name: 'v005_create_negotiation_rounds',
    statement: `CREATE TABLE IF NOT EXISTS negotiation_rounds (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(64) NOT NULL,
      round_no INT NOT NULL,
      role VARCHAR(32) NOT NULL,
      input JSON NULL,
      output JSON NULL,
      status VARCHAR(16) NOT NULL,
      error TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_round (request_id, round_no, role)
    )`,
  },
  {
    name: 'v006_create_options',
    statement: `CREATE TABLE IF NOT EXISTS options (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(64) NOT NULL,
      round_id BIGINT NULL,
      kind VARCHAR(32) NOT NULL,
      date_min DATE NULL,
      date_max DATE NULL,
      shifted_issues JSON NULL,
      rules_used JSON NULL,
      trace JSON NULL,
      meets_need BOOLEAN NOT NULL,
      shift_cost INT NOT NULL DEFAULT 0,
      recommended BOOLEAN NOT NULL DEFAULT FALSE,
      INDEX idx_options_request (request_id)
    )`,
  },
  {
    name: 'v007_create_approvals',
    statement: `CREATE TABLE IF NOT EXISTS approvals (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(64) NOT NULL,
      option_id BIGINT NOT NULL,
      team_id VARCHAR(64) NOT NULL,
      actor_account_id VARCHAR(128) NOT NULL,
      decision VARCHAR(16) NOT NULL,
      reason TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_approvals_request (request_id)
    )`,
  },
  {
    name: 'v008_create_contracts',
    statement: `CREATE TABLE IF NOT EXISTS contracts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      request_id VARCHAR(64) NOT NULL UNIQUE,
      option_id BIGINT NOT NULL,
      deliverable_issue_key VARCHAR(64) NULL,
      agreed_date_min DATE NOT NULL,
      agreed_date_max DATE NOT NULL,
      status VARCHAR(16) NOT NULL,
      projected_date DATE NULL,
      last_evaluated_at DATETIME NULL,
      INDEX idx_contracts_status (status)
    )`,
  },
  {
    name: 'v009_create_dependency_edges',
    statement: `CREATE TABLE IF NOT EXISTS dependency_edges (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      contract_id BIGINT NOT NULL,
      from_team_id VARCHAR(64) NOT NULL,
      to_team_id VARCHAR(64) NOT NULL,
      relation VARCHAR(64) NOT NULL DEFAULT 'agreed-dependency',
      INDEX idx_edges_teams (from_team_id, to_team_id)
    )`,
  },
  {
    name: 'v010_create_audit_log',
    statement: `CREATE TABLE IF NOT EXISTS audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      entity_type VARCHAR(32) NOT NULL,
      entity_id VARCHAR(64) NOT NULL,
      action VARCHAR(64) NOT NULL,
      actor_account_id VARCHAR(128) NULL,
      payload JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_entity (entity_type, entity_id)
    )`,
  },
  {
    name: 'v011_create_demo_seed_steps',
    statement: `CREATE TABLE IF NOT EXISTS demo_seed_steps (
      step VARCHAR(32) PRIMARY KEY,
      position INT NOT NULL,
      status VARCHAR(16) NOT NULL,
      detail TEXT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  },
  // v012–v014: idempotent (IF NOT EXISTS), so a partially applied run can be repeated safely.
  {
    name: 'v012_unique_dependency_edge_contract',
    statement: 'CREATE UNIQUE INDEX IF NOT EXISTS uq_edges_contract ON dependency_edges (contract_id)',
  },
  {
    name: 'v013_index_requests_source_issue',
    statement: 'CREATE INDEX IF NOT EXISTS idx_requests_source_issue ON requests (source_issue_key)',
  },
  {
    name: 'v014_index_contracts_deliverable_issue',
    statement: 'CREATE INDEX IF NOT EXISTS idx_contracts_deliverable_issue ON contracts (deliverable_issue_key)',
  },
];

/** Applies pending migrations; safe to call on every cold start. */
export async function runMigrations(): Promise<string[]> {
  const runner = MIGRATIONS.reduce(
    (acc, migration) => acc.enqueue(migration.name, migration.statement),
    migrationRunner,
  );
  return runner.run();
}
