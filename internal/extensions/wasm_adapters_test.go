package extensions

import (
	"context"
	"encoding/json"
	"testing"
)

// TestWASMEntityAdapter tests the entity reader adapter.
func TestWASMEntityAdapter(t *testing.T) {
	adapter := NewWASMEntityAdapter(
		func(ctx context.Context, id string) (json.RawMessage, error) {
			return json.RawMessage(`{"id":"` + id + `","name":"Gandalf"}`), nil
		},
		func(ctx context.Context, campaignID, query string, limit int) (json.RawMessage, error) {
			return json.RawMessage(`[{"name":"match"}]`), nil
		},
		func(ctx context.Context, campaignID string) (json.RawMessage, error) {
			return json.RawMessage(`[{"slug":"npc","name":"NPCs"}]`), nil
		},
	)

	t.Run("GetEntityJSON", func(t *testing.T) {
		result, err := adapter.GetEntityJSON(t.Context(), "camp-1", "ent-42")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(result) != `{"id":"ent-42","name":"Gandalf"}` {
			t.Errorf("unexpected result: %s", result)
		}
	})

	t.Run("SearchEntitiesJSON", func(t *testing.T) {
		result, err := adapter.SearchEntitiesJSON(t.Context(), "camp-1", "gand", 10)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(result) != `[{"name":"match"}]` {
			t.Errorf("unexpected result: %s", result)
		}
	})

	t.Run("ListEntityTypesJSON", func(t *testing.T) {
		result, err := adapter.ListEntityTypesJSON(t.Context(), "camp-1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(result) != `[{"slug":"npc","name":"NPCs"}]` {
			t.Errorf("unexpected result: %s", result)
		}
	})
}

// TestWASMCalendarAdapter tests the calendar reader adapter.
func TestWASMCalendarAdapter(t *testing.T) {
	adapter := NewWASMCalendarAdapter(
		func(ctx context.Context, campaignID string) (json.RawMessage, error) {
			return json.RawMessage(`{"name":"Harptos Calendar"}`), nil
		},
		func(ctx context.Context, campaignID string, limit int) (json.RawMessage, error) {
			return json.RawMessage(`[{"name":"Festival"}]`), nil
		},
	)

	t.Run("GetCalendarJSON", func(t *testing.T) {
		result, err := adapter.GetCalendarJSON(t.Context(), "camp-1")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(result) != `{"name":"Harptos Calendar"}` {
			t.Errorf("unexpected result: %s", result)
		}
	})

	t.Run("ListEventsJSON", func(t *testing.T) {
		result, err := adapter.ListEventsJSON(t.Context(), "camp-1", 50)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(result) != `[{"name":"Festival"}]` {
			t.Errorf("unexpected result: %s", result)
		}
	})
}

// TestWASMTagAdapter tests the tag reader adapter.
func TestWASMTagAdapter(t *testing.T) {
	adapter := NewWASMTagAdapter(
		func(ctx context.Context, campaignID string) (json.RawMessage, error) {
			return json.RawMessage(`[{"name":"Magic"},{"name":"Combat"}]`), nil
		},
	)

	result, err := adapter.ListTagsJSON(t.Context(), "camp-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(result) != `[{"name":"Magic"},{"name":"Combat"}]` {
		t.Errorf("unexpected result: %s", result)
	}
}

// TestHostEnvironmentBuildFunctions tests capability-based host function filtering.
func TestHostEnvironmentBuildFunctions(t *testing.T) {
	env := NewHostEnvironment(nil, nil, nil, nil)

	tests := []struct {
		name         string
		capabilities map[string]bool
		wantCount    int
	}{
		{
			name:         "log only",
			capabilities: map[string]bool{"log": true},
			wantCount:    1, // chronicle_log
		},
		{
			name:         "entity_read",
			capabilities: map[string]bool{"entity_read": true},
			wantCount:    3, // get_entity, search_entities, list_entity_types
		},
		{
			name:         "calendar_read",
			capabilities: map[string]bool{"calendar_read": true},
			wantCount:    2, // get_calendar, list_events
		},
		{
			name:         "tag_read",
			capabilities: map[string]bool{"tag_read": true},
			wantCount:    1, // list_tags
		},
		{
			name:         "kv_store",
			capabilities: map[string]bool{"kv_store": true},
			wantCount:    3, // kv_get, kv_set, kv_delete
		},
		{
			name: "all capabilities",
			capabilities: map[string]bool{
				"log": true, "entity_read": true, "calendar_read": true,
				"tag_read": true, "kv_store": true,
			},
			wantCount: 10, // 1 + 3 + 2 + 1 + 3
		},
		{
			name:         "no capabilities",
			capabilities: map[string]bool{},
			wantCount:    0,
		},
		{
			name:         "log and kv_store",
			capabilities: map[string]bool{"log": true, "kv_store": true},
			wantCount:    4, // 1 + 3
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			funcs := env.BuildHostFunctions(tt.capabilities)
			if len(funcs) != tt.wantCount {
				t.Errorf("expected %d host functions, got %d", tt.wantCount, len(funcs))
			}
		})
	}
}

// TestHostEnvironmentCallContext tests set/get/clear call context.
func TestHostEnvironmentCallContext(t *testing.T) {
	env := NewHostEnvironment(nil, nil, nil, nil)

	// No context initially.
	cs := env.getCallState("ext-1", "slug-1")
	if cs != nil {
		t.Fatal("expected no call state initially")
	}

	// Set context.
	env.SetCallContext("ext-1", "slug-1", "camp-123")
	cs = env.getCallState("ext-1", "slug-1")
	if cs == nil {
		t.Fatal("expected call state after SetCallContext")
	}
	if cs.campaignID != "camp-123" {
		t.Errorf("expected campaign 'camp-123', got %q", cs.campaignID)
	}

	// Clear context.
	env.ClearCallContext("ext-1", "slug-1")
	cs = env.getCallState("ext-1", "slug-1")
	if cs != nil {
		t.Fatal("expected no call state after ClearCallContext")
	}
}

// TestPluginManagerUnloadNotLoaded tests unloading a non-existent plugin.
func TestPluginManagerUnloadNotLoaded(t *testing.T) {
	pm := NewPluginManager("/tmp/nonexistent", nil)
	err := pm.Unload(t.Context(), "ext-1", "slug-1")
	if err == nil {
		t.Error("expected error when unloading non-existent plugin")
	}
}

// TestPluginManagerReloadNotLoaded tests reloading a non-existent plugin.
func TestPluginManagerReloadNotLoaded(t *testing.T) {
	pm := NewPluginManager("/tmp/nonexistent", nil)
	err := pm.Reload(t.Context(), "ext-1", "slug-1")
	if err == nil {
		t.Error("expected error when reloading non-existent plugin")
	}
}

// TestPluginManagerCallNotLoaded tests calling a non-existent plugin.
func TestPluginManagerCallNotLoaded(t *testing.T) {
	pm := NewPluginManager("/tmp/nonexistent", nil)
	_, err := pm.Call(t.Context(), "ext-1", "slug-1", "test", nil)
	if err == nil {
		t.Error("expected error when calling non-existent plugin")
	}
}
