package campaigns

import (
	"encoding/json"
	"testing"
)

func TestParseRoleDashboardLayout_NilColumn(t *testing.T) {
	c := &Campaign{}
	got := c.ParseRoleDashboardLayout(RolePlayer)
	if got != nil {
		t.Error("expected nil for nil dashboard_layout")
	}
}

func TestParseRoleDashboardLayout_LegacyFormat(t *testing.T) {
	raw := `{"rows":[{"id":"r1","columns":[{"id":"c1","width":12,"blocks":[]}]}]}`
	c := &Campaign{DashboardLayout: &raw}

	// All roles should get the same layout from legacy format.
	for _, role := range []Role{RolePlayer, RoleScribe, RoleOwner} {
		layout := c.ParseRoleDashboardLayout(role)
		if layout == nil {
			t.Fatalf("expected layout for role %d, got nil", role)
		}
		if len(layout.Rows) != 1 {
			t.Errorf("expected 1 row for role %d, got %d", role, len(layout.Rows))
		}
	}
}

func TestParseRoleDashboardLayout_RoleKeyedFormat(t *testing.T) {
	raw := `{
		"default": {"rows":[{"id":"d1","columns":[]}]},
		"player":  {"rows":[{"id":"p1","columns":[]},{"id":"p2","columns":[]}]},
		"scribe":  {"rows":[{"id":"s1","columns":[]},{"id":"s2","columns":[]},{"id":"s3","columns":[]}]}
	}`
	c := &Campaign{DashboardLayout: &raw}

	// Player should get player layout (2 rows).
	pl := c.ParseRoleDashboardLayout(RolePlayer)
	if pl == nil || len(pl.Rows) != 2 {
		t.Errorf("player: expected 2 rows, got %v", pl)
	}

	// Scribe should get scribe layout (3 rows).
	sl := c.ParseRoleDashboardLayout(RoleScribe)
	if sl == nil || len(sl.Rows) != 3 {
		t.Errorf("scribe: expected 3 rows, got %v", sl)
	}

	// Owner should fall back to default (1 row).
	ol := c.ParseRoleDashboardLayout(RoleOwner)
	if ol == nil || len(ol.Rows) != 1 {
		t.Errorf("owner: expected 1 row (default), got %v", ol)
	}
}

func TestParseRoleDashboardLayout_FallbackToDefault(t *testing.T) {
	raw := `{"default": {"rows":[{"id":"d1","columns":[]}]}}`
	c := &Campaign{DashboardLayout: &raw}

	// Player has no override, should fall back to default.
	pl := c.ParseRoleDashboardLayout(RolePlayer)
	if pl == nil || len(pl.Rows) != 1 {
		t.Errorf("player fallback: expected 1 row, got %v", pl)
	}
}

func TestGetRoleDashboardJSON(t *testing.T) {
	raw := `{
		"default": {"rows":[{"id":"d1","columns":[]}]},
		"player":  {"rows":[{"id":"p1","columns":[]}]}
	}`
	c := &Campaign{DashboardLayout: &raw}

	if got := c.GetRoleDashboardJSON("default"); got == nil || len(got.Rows) != 1 {
		t.Error("expected default layout")
	}
	if got := c.GetRoleDashboardJSON("player"); got == nil || len(got.Rows) != 1 {
		t.Error("expected player layout")
	}
	if got := c.GetRoleDashboardJSON("scribe"); got != nil {
		t.Error("expected nil for missing scribe layout")
	}
}

func TestSetRoleDashboardJSON(t *testing.T) {
	c := &Campaign{} // Start with nil dashboard_layout.

	newLayout := &DashboardLayout{Rows: []DashboardRow{{ID: "r1"}}}

	// Set player layout.
	result, err := c.SetRoleDashboardJSON("player", newLayout)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}

	// Verify the wrapper has player layout.
	var roles RoleDashboardLayouts
	if err := json.Unmarshal([]byte(*result), &roles); err != nil {
		t.Fatalf("failed to parse result: %v", err)
	}
	if roles.Player == nil || len(roles.Player.Rows) != 1 {
		t.Error("expected player layout with 1 row")
	}
	if roles.Default != nil {
		t.Error("expected nil default (not set)")
	}
}

func TestSetRoleDashboardJSON_MigratesLegacy(t *testing.T) {
	legacy := `{"rows":[{"id":"d1","columns":[]}]}`
	c := &Campaign{DashboardLayout: &legacy}

	newPlayer := &DashboardLayout{Rows: []DashboardRow{{ID: "p1"}}}
	result, err := c.SetRoleDashboardJSON("player", newPlayer)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify legacy was migrated to default.
	var roles RoleDashboardLayouts
	if err := json.Unmarshal([]byte(*result), &roles); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if roles.Default == nil || len(roles.Default.Rows) != 1 {
		t.Error("expected legacy layout migrated to default")
	}
	if roles.Player == nil || len(roles.Player.Rows) != 1 {
		t.Error("expected player layout set")
	}
}

func TestRemoveRoleDashboardJSON(t *testing.T) {
	raw := `{
		"default": {"rows":[{"id":"d1","columns":[]}]},
		"player":  {"rows":[{"id":"p1","columns":[]}]}
	}`
	c := &Campaign{DashboardLayout: &raw}

	result, err := c.RemoveRoleDashboardJSON("player")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil (default still exists)")
	}

	var roles RoleDashboardLayouts
	if err := json.Unmarshal([]byte(*result), &roles); err != nil {
		t.Fatalf("failed to parse: %v", err)
	}
	if roles.Player != nil {
		t.Error("expected player to be removed")
	}
	if roles.Default == nil {
		t.Error("expected default to remain")
	}
}

func TestRemoveRoleDashboardJSON_AllRemoved(t *testing.T) {
	raw := `{"player": {"rows":[{"id":"p1","columns":[]}]}}`
	c := &Campaign{DashboardLayout: &raw}

	result, err := c.RemoveRoleDashboardJSON("player")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result != nil {
		t.Error("expected nil when all roles removed")
	}
}
