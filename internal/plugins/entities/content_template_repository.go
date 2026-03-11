package entities

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/keyxmakerx/chronicle/internal/apperror"
)

// ContentTemplateRepository defines data access for content templates.
type ContentTemplateRepository interface {
	Create(ctx context.Context, t *ContentTemplate) error
	FindByID(ctx context.Context, id int) (*ContentTemplate, error)
	ListForCampaign(ctx context.Context, campaignID string) ([]ContentTemplate, error)
	ListForCampaignAndType(ctx context.Context, campaignID string, entityTypeID int) ([]ContentTemplate, error)
	Update(ctx context.Context, t *ContentTemplate) error
	Delete(ctx context.Context, id int) error
}

type contentTemplateRepository struct {
	db *sql.DB
}

// NewContentTemplateRepository creates a new content template repository.
func NewContentTemplateRepository(db *sql.DB) ContentTemplateRepository {
	return &contentTemplateRepository{db: db}
}

// Create inserts a new content template.
func (r *contentTemplateRepository) Create(ctx context.Context, t *ContentTemplate) error {
	query := `INSERT INTO content_templates
		(campaign_id, entity_type_id, name, description, content_json, content_html, icon, sort_order, is_global)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	var entityTypeID *int
	if t.EntityTypeID != nil && *t.EntityTypeID > 0 {
		entityTypeID = t.EntityTypeID
	}

	result, err := r.db.ExecContext(ctx, query,
		t.CampaignID, entityTypeID, t.Name, t.Description,
		t.ContentJSON, t.ContentHTML, t.Icon, t.SortOrder, t.IsGlobal)
	if err != nil {
		return fmt.Errorf("inserting content template: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return fmt.Errorf("getting last insert id: %w", err)
	}
	t.ID = int(id)
	return nil
}

// FindByID retrieves a content template by its ID.
func (r *contentTemplateRepository) FindByID(ctx context.Context, id int) (*ContentTemplate, error) {
	query := `SELECT ct.id, ct.campaign_id, ct.entity_type_id, ct.name, ct.description,
		ct.content_json, ct.content_html, ct.icon, ct.sort_order, ct.is_global,
		ct.created_at, ct.updated_at,
		COALESCE(et.name, '') AS entity_type_name
		FROM content_templates ct
		LEFT JOIN entity_types et ON ct.entity_type_id = et.id
		WHERE ct.id = ?`

	var t ContentTemplate
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&t.ID, &t.CampaignID, &t.EntityTypeID, &t.Name, &t.Description,
		&t.ContentJSON, &t.ContentHTML, &t.Icon, &t.SortOrder, &t.IsGlobal,
		&t.CreatedAt, &t.UpdatedAt, &t.EntityTypeName)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, apperror.NewNotFound("content template not found")
		}
		return nil, fmt.Errorf("finding content template: %w", err)
	}
	return &t, nil
}

// ListForCampaign returns all templates available to a campaign (campaign-specific + global).
func (r *contentTemplateRepository) ListForCampaign(ctx context.Context, campaignID string) ([]ContentTemplate, error) {
	query := `SELECT ct.id, ct.campaign_id, ct.entity_type_id, ct.name, ct.description,
		ct.content_json, ct.content_html, ct.icon, ct.sort_order, ct.is_global,
		ct.created_at, ct.updated_at,
		COALESCE(et.name, '') AS entity_type_name
		FROM content_templates ct
		LEFT JOIN entity_types et ON ct.entity_type_id = et.id
		WHERE ct.campaign_id = ? OR ct.is_global = TRUE
		ORDER BY ct.is_global DESC, ct.sort_order, ct.name`

	return r.scanRows(ctx, query, campaignID)
}

// ListForCampaignAndType returns templates matching a specific entity type
// plus any templates not bound to a type (universal templates).
func (r *contentTemplateRepository) ListForCampaignAndType(ctx context.Context, campaignID string, entityTypeID int) ([]ContentTemplate, error) {
	query := `SELECT ct.id, ct.campaign_id, ct.entity_type_id, ct.name, ct.description,
		ct.content_json, ct.content_html, ct.icon, ct.sort_order, ct.is_global,
		ct.created_at, ct.updated_at,
		COALESCE(et.name, '') AS entity_type_name
		FROM content_templates ct
		LEFT JOIN entity_types et ON ct.entity_type_id = et.id
		WHERE (ct.campaign_id = ? OR ct.is_global = TRUE)
		  AND (ct.entity_type_id = ? OR ct.entity_type_id IS NULL)
		ORDER BY ct.is_global DESC, ct.sort_order, ct.name`

	return r.scanRows(ctx, query, campaignID, entityTypeID)
}

// Update modifies an existing content template.
func (r *contentTemplateRepository) Update(ctx context.Context, t *ContentTemplate) error {
	query := `UPDATE content_templates
		SET name = ?, description = ?, content_json = ?, content_html = ?, icon = ?,
		    entity_type_id = ?
		WHERE id = ?`

	var entityTypeID *int
	if t.EntityTypeID != nil && *t.EntityTypeID > 0 {
		entityTypeID = t.EntityTypeID
	}

	_, err := r.db.ExecContext(ctx, query,
		t.Name, t.Description, t.ContentJSON, t.ContentHTML, t.Icon,
		entityTypeID, t.ID)
	if err != nil {
		return fmt.Errorf("updating content template: %w", err)
	}
	return nil
}

// Delete removes a content template by ID.
func (r *contentTemplateRepository) Delete(ctx context.Context, id int) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM content_templates WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("deleting content template: %w", err)
	}
	return nil
}

// scanRows scans multiple content template rows from a query.
func (r *contentTemplateRepository) scanRows(ctx context.Context, query string, args ...any) ([]ContentTemplate, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying content templates: %w", err)
	}
	defer rows.Close()

	var templates []ContentTemplate
	for rows.Next() {
		var t ContentTemplate
		if err := rows.Scan(
			&t.ID, &t.CampaignID, &t.EntityTypeID, &t.Name, &t.Description,
			&t.ContentJSON, &t.ContentHTML, &t.Icon, &t.SortOrder, &t.IsGlobal,
			&t.CreatedAt, &t.UpdatedAt, &t.EntityTypeName); err != nil {
			return nil, fmt.Errorf("scanning content template: %w", err)
		}
		templates = append(templates, t)
	}
	return templates, rows.Err()
}
