// Package database provides connection setup for MariaDB and Redis.
// This file validates migration SQL files to catch schema mismatches early.
package database

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// lintFromVersion is the minimum migration number to enforce new lint rules on.
// Migrations before this version are already applied in production and cannot be
// edited. Bump this when cutting a release so that newly-enforced rules only
// apply to migrations written after the cutoff.
const lintFromVersion = 62

// isLintable returns true if the migration file number is >= lintFromVersion.
// Files that don't match the NNNNNN_ prefix pattern are always linted.
func isLintable(filename string) bool {
	base := filepath.Base(filename)
	if len(base) < 6 {
		return true
	}
	prefix := base[:6]
	num := 0
	for _, ch := range prefix {
		if ch < '0' || ch > '9' {
			return true // Not a numbered migration, always lint.
		}
		num = num*10 + int(ch-'0')
	}
	return num >= lintFromVersion
}

// validAddonCategories must match the ENUM values on addons.category.
// Update this set when adding new ENUM values via ALTER TABLE.
// Current ENUM: ENUM('system', 'widget', 'integration', 'plugin')
// Defined in 000015, extended in 000027, renamed module→system in 000060.
var validAddonCategories = map[string]bool{
	"system":      true,
	"module":      true, // Legacy: referenced in old migrations.
	"widget":      true,
	"integration": true,
	"plugin":      true,
}

// validAddonStatuses must match the ENUM values on addons.status.
// Current ENUM: ENUM('active', 'planned', 'deprecated')
// Defined in 000015.
var validAddonStatuses = map[string]bool{
	"active":     true,
	"planned":    true,
	"deprecated": true,
}

// migrationsDir returns the absolute path to db/migrations/ from the project root.
func migrationsDir(t *testing.T) string {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot determine test file path")
	}
	// thisFile is internal/database/migrate_test.go, project root is two dirs up.
	projectRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	dir := filepath.Join(projectRoot, "db", "migrations")
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("migrations directory not found at %s: %v", dir, err)
	}
	return dir
}

// TestMigrations_AddonCategoryValues scans all .up.sql migration files for
// INSERT or UPDATE statements that reference the addons table and validates
// that any category values used are valid ENUM members. This prevents the
// "Data truncated for column 'category'" crash (Error 1265) that occurs
// when an invalid ENUM value is used.
func TestMigrations_AddonCategoryValues(t *testing.T) {
	dir := migrationsDir(t)
	files, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil {
		t.Fatalf("globbing migration files: %v", err)
	}
	if len(files) == 0 {
		t.Fatal("no migration files found")
	}

	// Match category = 'value' or category, ... 'value' patterns.
	categoryPattern := regexp.MustCompile(`category\s*[=,]\s*'([^']+)'`)

	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("reading %s: %v", f, err)
		}
		content := string(data)

		// Only check files that reference the addons table.
		if !strings.Contains(content, "addons") {
			continue
		}

		// Skip ALTER TABLE statements (they define the ENUM, not use it).
		// We only care about INSERT/UPDATE statements.
		lines := strings.Split(content, "\n")
		inAlter := false
		for _, line := range lines {
			trimmed := strings.TrimSpace(strings.ToUpper(line))
			if strings.HasPrefix(trimmed, "ALTER TABLE") {
				inAlter = true
			}
			if inAlter {
				if strings.Contains(line, ";") {
					inAlter = false
				}
				continue
			}

			matches := categoryPattern.FindAllStringSubmatch(line, -1)
			for _, match := range matches {
				value := match[1]
				if !validAddonCategories[value] {
					t.Errorf("%s: invalid addon category %q; valid values: module, widget, integration, plugin",
						filepath.Base(f), value)
				}
			}
		}
	}
}

// TestMigrations_AddonStatusValues validates status ENUM values in migration files.
func TestMigrations_AddonStatusValues(t *testing.T) {
	dir := migrationsDir(t)
	files, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil {
		t.Fatalf("globbing migration files: %v", err)
	}

	statusPattern := regexp.MustCompile(`status\s*[=,]\s*'([^']+)'`)

	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("reading %s: %v", f, err)
		}
		content := string(data)

		if !strings.Contains(content, "addons") {
			continue
		}

		// Skip ALTER TABLE and CREATE TABLE (ENUM definitions).
		lines := strings.Split(content, "\n")
		inDDL := false
		for _, line := range lines {
			trimmed := strings.TrimSpace(strings.ToUpper(line))
			if strings.HasPrefix(trimmed, "ALTER TABLE") || strings.HasPrefix(trimmed, "CREATE TABLE") {
				inDDL = true
			}
			if inDDL {
				if strings.Contains(line, ";") {
					inDDL = false
				}
				continue
			}

			matches := statusPattern.FindAllStringSubmatch(line, -1)
			for _, match := range matches {
				value := match[1]
				if !validAddonStatuses[value] {
					t.Errorf("%s: invalid addon status %q; valid values: active, planned, deprecated",
						filepath.Base(f), value)
				}
			}
		}
	}
}

// TestMigrations_UpDownPairs ensures every .up.sql has a matching .down.sql.
func TestMigrations_UpDownPairs(t *testing.T) {
	dir := migrationsDir(t)
	upFiles, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil {
		t.Fatalf("globbing up files: %v", err)
	}

	for _, up := range upFiles {
		down := strings.Replace(up, ".up.sql", ".down.sql", 1)
		if _, err := os.Stat(down); err != nil {
			t.Errorf("missing down migration for %s", filepath.Base(up))
		}
	}
}

// TestMigrations_DropIndexRequiresDropFK detects DROP INDEX on an index that
// backs a FOREIGN KEY constraint without a preceding DROP FOREIGN KEY on the
// same table. MariaDB Error 1553: "Cannot drop index '...': needed in a
// foreign key constraint." This was the root cause of the 000063 production
// failure. The test parses each migration file for the pattern and flags it.
func TestMigrations_DropIndexRequiresDropFK(t *testing.T) {
	dir := migrationsDir(t)
	allFiles, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		t.Fatalf("globbing migration files: %v", err)
	}

	// Patterns for extracting table and index/constraint names.
	// Case-insensitive to handle varying SQL styles.
	dropIndexRe := regexp.MustCompile(`(?i)ALTER\s+TABLE\s+(\w+)\s+DROP\s+(?:INDEX|KEY)\s+(\w+)`)
	dropFKRe := regexp.MustCompile(`(?i)ALTER\s+TABLE\s+(\w+)\s+DROP\s+FOREIGN\s+KEY\s+(\w+)`)
	// Detect FKs that reference the same index being dropped. Convention:
	// FK name contains the index name or vice versa, but the reliable signal
	// is simply that a DROP FOREIGN KEY on the same table precedes the DROP INDEX.
	addFKOnIndexRe := regexp.MustCompile(`(?i)ADD\s+CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\([^)]+\)`)

	for _, f := range allFiles {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("reading %s: %v", f, err)
		}
		content := string(data)
		base := filepath.Base(f)

		// Split into statements to analyze ordering.
		statements := splitStatements(content)

		// Track which tables have had their FK dropped (by statement order).
		// Key: lowercase table name. Value: true if DROP FOREIGN KEY seen.
		fkDropped := make(map[string]bool)

		for _, stmt := range statements {
			// Record DROP FOREIGN KEY statements.
			if fkMatches := dropFKRe.FindAllStringSubmatch(stmt, -1); fkMatches != nil {
				for _, m := range fkMatches {
					table := strings.ToLower(m[1])
					fkDropped[table] = true
				}
			}

			// Check DROP INDEX statements — table must have FK dropped first.
			if idxMatches := dropIndexRe.FindAllStringSubmatch(stmt, -1); idxMatches != nil {
				for _, m := range idxMatches {
					table := strings.ToLower(m[1])
					indexName := strings.ToLower(m[2])

					// Only flag if this file also adds a FK referencing this
					// table+index pattern (indicating the index backs a FK).
					if indexBacksFK(content, table, indexName, addFKOnIndexRe) && !fkDropped[table] {
						t.Errorf("%s: DROP INDEX %s on table %q without preceding DROP FOREIGN KEY — "+
							"MariaDB will fail with Error 1553 if the index backs a FK constraint. "+
							"Add DROP FOREIGN KEY before DROP INDEX, then re-add the FK after the new index.",
							base, m[2], m[1])
					}
				}
			}
		}
	}
}

// TestMigrations_CreateTableIdempotent checks that CREATE TABLE uses
// IF NOT EXISTS and DROP TABLE uses IF EXISTS. Without these guards,
// a partially-failed migration that retries will crash on "table already
// exists" or "table doesn't exist" errors.
func TestMigrations_CreateTableIdempotent(t *testing.T) {
	dir := migrationsDir(t)

	// Check up migrations for CREATE TABLE without IF NOT EXISTS.
	upFiles, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil {
		t.Fatalf("globbing up files: %v", err)
	}

	createRe := regexp.MustCompile(`(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)`)
	createSafeRe := regexp.MustCompile(`(?i)CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS`)

	for _, f := range upFiles {
		if !isLintable(f) {
			continue
		}
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("reading %s: %v", f, err)
		}

		for _, match := range createRe.FindAllString(string(data), -1) {
			if !createSafeRe.MatchString(match) {
				t.Errorf("%s: CREATE TABLE without IF NOT EXISTS — migration retries will fail. "+
					"Use CREATE TABLE IF NOT EXISTS instead.", filepath.Base(f))
			}
		}
	}

	// Check down migrations for DROP TABLE without IF EXISTS.
	downFiles, err := filepath.Glob(filepath.Join(dir, "*.down.sql"))
	if err != nil {
		t.Fatalf("globbing down files: %v", err)
	}

	dropRe := regexp.MustCompile(`(?i)DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)`)
	dropSafeRe := regexp.MustCompile(`(?i)DROP\s+TABLE\s+IF\s+EXISTS`)

	for _, f := range downFiles {
		if !isLintable(f) {
			continue
		}
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("reading %s: %v", f, err)
		}

		for _, match := range dropRe.FindAllString(string(data), -1) {
			if !dropSafeRe.MatchString(match) {
				t.Errorf("%s: DROP TABLE without IF EXISTS — rollback retries will fail. "+
					"Use DROP TABLE IF EXISTS instead.", filepath.Base(f))
			}
		}
	}
}

// TestMigrations_DownReversesUp validates that down migrations contain the
// inverse operations for key DDL in the corresponding up migration. This
// catches cases where a down migration forgets to drop a column, table,
// or constraint that was added in the up migration.
func TestMigrations_DownReversesUp(t *testing.T) {
	dir := migrationsDir(t)
	upFiles, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil {
		t.Fatalf("globbing up files: %v", err)
	}

	addColRe := regexp.MustCompile(`(?i)ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)`)
	dropColRe := regexp.MustCompile(`(?i)(?:ALTER\s+TABLE\s+(\w+)\s+)?DROP\s+COLUMN\s+(\w+)`)
	createTableRe := regexp.MustCompile(`(?i)CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)`)
	dropTableRe := regexp.MustCompile(`(?i)DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)`)

	for _, upFile := range upFiles {
		if !isLintable(upFile) {
			continue
		}
		downFile := strings.Replace(upFile, ".up.sql", ".down.sql", 1)
		if _, err := os.Stat(downFile); err != nil {
			continue // Missing down file is caught by TestMigrations_UpDownPairs.
		}

		upData, err := os.ReadFile(upFile)
		if err != nil {
			t.Fatalf("reading %s: %v", upFile, err)
		}
		downData, err := os.ReadFile(downFile)
		if err != nil {
			t.Fatalf("reading %s: %v", downFile, err)
		}
		downContent := strings.ToLower(string(downData))
		base := filepath.Base(upFile)

		// Check: ADD COLUMN in up → DROP COLUMN in down.
		for _, m := range addColRe.FindAllStringSubmatch(string(upData), -1) {
			col := strings.ToLower(m[2])
			if !dropColRe.MatchString(string(downData)) || !strings.Contains(downContent, col) {
				t.Errorf("%s: up adds column %s.%s but down migration doesn't drop it",
					base, m[1], m[2])
			}
		}

		// Check: CREATE TABLE in up → DROP TABLE in down.
		for _, m := range createTableRe.FindAllStringSubmatch(string(upData), -1) {
			table := strings.ToLower(m[1])
			found := false
			for _, dm := range dropTableRe.FindAllStringSubmatch(string(downData), -1) {
				if strings.ToLower(dm[1]) == table {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("%s: up creates table %s but down migration doesn't drop it",
					base, m[1])
			}
		}
	}
}

// splitStatements splits SQL content into individual statements by semicolons,
// ignoring semicolons inside comments. Returns trimmed, non-empty statements.
func splitStatements(sql string) []string {
	// Remove single-line comments.
	lines := strings.Split(sql, "\n")
	var cleaned []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "--") {
			continue
		}
		cleaned = append(cleaned, line)
	}
	joined := strings.Join(cleaned, "\n")

	parts := strings.Split(joined, ";")
	var stmts []string
	for _, p := range parts {
		s := strings.TrimSpace(p)
		if s != "" {
			stmts = append(stmts, s)
		}
	}
	return stmts
}

// indexBacksFK checks whether an index on the given table appears to back a
// foreign key constraint. It looks for ADD CONSTRAINT ... FOREIGN KEY patterns
// in the same file, or checks if the index name follows the fk_ naming convention
// used in CREATE TABLE definitions.
func indexBacksFK(content string, table string, indexName string, addFKRe *regexp.Regexp) bool {
	lower := strings.ToLower(content)

	// Check 1: The file itself contains an ADD CONSTRAINT ... FOREIGN KEY for this table.
	// This handles migrations that modify FK+index together.
	if strings.Contains(lower, "foreign key") && strings.Contains(lower, table) {
		return true
	}

	// Check 2: The index name follows the FK naming convention (fk_ prefix or
	// matches a known FK pattern like idx_<table>_<column> where a FK exists).
	if strings.HasPrefix(indexName, "fk_") {
		return true
	}

	return false
}
