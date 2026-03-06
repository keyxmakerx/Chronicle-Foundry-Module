package extensions

import (
	"context"
	"encoding/json"
)

// wasmEntityAdapter implements EntityReader by delegating to function closures.
// This avoids importing heavy plugin packages directly — the caller wires
// concrete service methods at startup in app/routes.go.
type wasmEntityAdapter struct {
	getByID        func(ctx context.Context, id string) (json.RawMessage, error)
	search         func(ctx context.Context, campaignID, query string, limit int) (json.RawMessage, error)
	listTypes      func(ctx context.Context, campaignID string) (json.RawMessage, error)
}

// NewWASMEntityAdapter creates an EntityReader from function closures.
func NewWASMEntityAdapter(
	getByID func(ctx context.Context, id string) (json.RawMessage, error),
	search func(ctx context.Context, campaignID, query string, limit int) (json.RawMessage, error),
	listTypes func(ctx context.Context, campaignID string) (json.RawMessage, error),
) EntityReader {
	return &wasmEntityAdapter{
		getByID:   getByID,
		search:    search,
		listTypes: listTypes,
	}
}

// GetEntityJSON implements EntityReader.
func (a *wasmEntityAdapter) GetEntityJSON(ctx context.Context, campaignID, entityID string) (json.RawMessage, error) {
	return a.getByID(ctx, entityID)
}

// SearchEntitiesJSON implements EntityReader.
func (a *wasmEntityAdapter) SearchEntitiesJSON(ctx context.Context, campaignID, query string, limit int) (json.RawMessage, error) {
	return a.search(ctx, campaignID, query, limit)
}

// ListEntityTypesJSON implements EntityReader.
func (a *wasmEntityAdapter) ListEntityTypesJSON(ctx context.Context, campaignID string) (json.RawMessage, error) {
	return a.listTypes(ctx, campaignID)
}

// wasmCalendarAdapter implements CalendarReader by delegating to function closures.
type wasmCalendarAdapter struct {
	getCalendar func(ctx context.Context, campaignID string) (json.RawMessage, error)
	listEvents  func(ctx context.Context, campaignID string, limit int) (json.RawMessage, error)
}

// NewWASMCalendarAdapter creates a CalendarReader from function closures.
func NewWASMCalendarAdapter(
	getCalendar func(ctx context.Context, campaignID string) (json.RawMessage, error),
	listEvents func(ctx context.Context, campaignID string, limit int) (json.RawMessage, error),
) CalendarReader {
	return &wasmCalendarAdapter{
		getCalendar: getCalendar,
		listEvents:  listEvents,
	}
}

// GetCalendarJSON implements CalendarReader.
func (a *wasmCalendarAdapter) GetCalendarJSON(ctx context.Context, campaignID string) (json.RawMessage, error) {
	return a.getCalendar(ctx, campaignID)
}

// ListEventsJSON implements CalendarReader.
func (a *wasmCalendarAdapter) ListEventsJSON(ctx context.Context, campaignID string, limit int) (json.RawMessage, error) {
	return a.listEvents(ctx, campaignID, limit)
}

// wasmTagAdapter implements TagReader by delegating to a function closure.
type wasmTagAdapter struct {
	listTags func(ctx context.Context, campaignID string) (json.RawMessage, error)
}

// NewWASMTagAdapter creates a TagReader from a function closure.
func NewWASMTagAdapter(
	listTags func(ctx context.Context, campaignID string) (json.RawMessage, error),
) TagReader {
	return &wasmTagAdapter{listTags: listTags}
}

// ListTagsJSON implements TagReader.
func (a *wasmTagAdapter) ListTagsJSON(ctx context.Context, campaignID string) (json.RawMessage, error) {
	return a.listTags(ctx, campaignID)
}
