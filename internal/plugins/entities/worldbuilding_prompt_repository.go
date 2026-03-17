package entities

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/keyxmakerx/chronicle/internal/apperror"
)

// WorldbuildingPromptRepository defines data access for worldbuilding prompts.
type WorldbuildingPromptRepository interface {
	Create(ctx context.Context, p *WorldbuildingPrompt) error
	FindByID(ctx context.Context, id int) (*WorldbuildingPrompt, error)
	ListForCampaign(ctx context.Context, campaignID string) ([]WorldbuildingPrompt, error)
	ListForCampaignAndType(ctx context.Context, campaignID string, entityTypeID int) ([]WorldbuildingPrompt, error)
	Update(ctx context.Context, p *WorldbuildingPrompt) error
	Delete(ctx context.Context, id int) error
}

type worldbuildingPromptRepository struct {
	db *sql.DB
}

// NewWorldbuildingPromptRepository creates a new worldbuilding prompt repository.
func NewWorldbuildingPromptRepository(db *sql.DB) WorldbuildingPromptRepository {
	return &worldbuildingPromptRepository{db: db}
}

// Create inserts a new worldbuilding prompt.
func (r *worldbuildingPromptRepository) Create(ctx context.Context, p *WorldbuildingPrompt) error {
	query := `INSERT INTO worldbuilding_prompts
		(campaign_id, entity_type_id, name, prompt_text, icon, sort_order, is_global)
		VALUES (?, ?, ?, ?, ?, ?, ?)`

	var entityTypeID *int
	if p.EntityTypeID != nil && *p.EntityTypeID > 0 {
		entityTypeID = p.EntityTypeID
	}

	result, err := r.db.ExecContext(ctx, query,
		p.CampaignID, entityTypeID, p.Name, p.PromptText,
		p.Icon, p.SortOrder, p.IsGlobal)
	if err != nil {
		return fmt.Errorf("inserting worldbuilding prompt: %w", err)
	}

	id, err := result.LastInsertId()
	if err != nil {
		return fmt.Errorf("getting last insert id: %w", err)
	}
	p.ID = int(id)
	return nil
}

// FindByID retrieves a worldbuilding prompt by its ID.
func (r *worldbuildingPromptRepository) FindByID(ctx context.Context, id int) (*WorldbuildingPrompt, error) {
	query := `SELECT wp.id, wp.campaign_id, wp.entity_type_id, wp.name, wp.prompt_text,
		wp.icon, wp.sort_order, wp.is_global, wp.created_at, wp.updated_at,
		COALESCE(et.name, '') AS entity_type_name
		FROM worldbuilding_prompts wp
		LEFT JOIN entity_types et ON wp.entity_type_id = et.id
		WHERE wp.id = ?`

	var p WorldbuildingPrompt
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&p.ID, &p.CampaignID, &p.EntityTypeID, &p.Name, &p.PromptText,
		&p.Icon, &p.SortOrder, &p.IsGlobal, &p.CreatedAt, &p.UpdatedAt,
		&p.EntityTypeName)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, apperror.NewNotFound("worldbuilding prompt not found")
		}
		return nil, fmt.Errorf("finding worldbuilding prompt: %w", err)
	}
	return &p, nil
}

// ListForCampaign returns all prompts available to a campaign (campaign-specific + global).
func (r *worldbuildingPromptRepository) ListForCampaign(ctx context.Context, campaignID string) ([]WorldbuildingPrompt, error) {
	query := `SELECT wp.id, wp.campaign_id, wp.entity_type_id, wp.name, wp.prompt_text,
		wp.icon, wp.sort_order, wp.is_global, wp.created_at, wp.updated_at,
		COALESCE(et.name, '') AS entity_type_name
		FROM worldbuilding_prompts wp
		LEFT JOIN entity_types et ON wp.entity_type_id = et.id
		WHERE wp.campaign_id = ? OR wp.is_global = TRUE
		ORDER BY wp.is_global DESC, wp.sort_order, wp.name`

	return r.scanRows(ctx, query, campaignID)
}

// ListForCampaignAndType returns prompts matching a specific entity type
// plus any prompts not bound to a type (universal prompts).
func (r *worldbuildingPromptRepository) ListForCampaignAndType(ctx context.Context, campaignID string, entityTypeID int) ([]WorldbuildingPrompt, error) {
	query := `SELECT wp.id, wp.campaign_id, wp.entity_type_id, wp.name, wp.prompt_text,
		wp.icon, wp.sort_order, wp.is_global, wp.created_at, wp.updated_at,
		COALESCE(et.name, '') AS entity_type_name
		FROM worldbuilding_prompts wp
		LEFT JOIN entity_types et ON wp.entity_type_id = et.id
		WHERE (wp.campaign_id = ? OR wp.is_global = TRUE)
		  AND (wp.entity_type_id = ? OR wp.entity_type_id IS NULL)
		ORDER BY wp.is_global DESC, wp.sort_order, wp.name`

	return r.scanRows(ctx, query, campaignID, entityTypeID)
}

// Update modifies an existing worldbuilding prompt.
func (r *worldbuildingPromptRepository) Update(ctx context.Context, p *WorldbuildingPrompt) error {
	query := `UPDATE worldbuilding_prompts
		SET name = ?, prompt_text = ?, icon = ?, entity_type_id = ?
		WHERE id = ?`

	var entityTypeID *int
	if p.EntityTypeID != nil && *p.EntityTypeID > 0 {
		entityTypeID = p.EntityTypeID
	}

	_, err := r.db.ExecContext(ctx, query, p.Name, p.PromptText, p.Icon, entityTypeID, p.ID)
	if err != nil {
		return fmt.Errorf("updating worldbuilding prompt: %w", err)
	}
	return nil
}

// Delete removes a worldbuilding prompt by ID.
func (r *worldbuildingPromptRepository) Delete(ctx context.Context, id int) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM worldbuilding_prompts WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("deleting worldbuilding prompt: %w", err)
	}
	return nil
}

// scanRows scans multiple worldbuilding prompt rows from a query.
func (r *worldbuildingPromptRepository) scanRows(ctx context.Context, query string, args ...any) ([]WorldbuildingPrompt, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("querying worldbuilding prompts: %w", err)
	}
	defer rows.Close()

	var prompts []WorldbuildingPrompt
	for rows.Next() {
		var p WorldbuildingPrompt
		if err := rows.Scan(
			&p.ID, &p.CampaignID, &p.EntityTypeID, &p.Name, &p.PromptText,
			&p.Icon, &p.SortOrder, &p.IsGlobal, &p.CreatedAt, &p.UpdatedAt,
			&p.EntityTypeName); err != nil {
			return nil, fmt.Errorf("scanning worldbuilding prompt: %w", err)
		}
		prompts = append(prompts, p)
	}
	return prompts, rows.Err()
}
