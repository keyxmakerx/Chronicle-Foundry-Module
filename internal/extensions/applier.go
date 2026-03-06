// Package extensions — applier.go implements content application logic.
// When a campaign owner enables an extension, the applier reads the manifest's
// contributes section and creates the declared content (entity types, tags,
// calendar presets) in the campaign. All created records are tracked via
// provenance so they can be identified and optionally removed on uninstall.
package extensions

import (
	"context"
	"log/slog"
	"strconv"
)

// ContentApplier applies extension content to a campaign when enabled.
// Implementations call out to other domain services (entities, tags, etc.)
// and record provenance for each created record.
type ContentApplier interface {
	// Apply reads the extension manifest and creates content in the campaign.
	Apply(ctx context.Context, campaignID string, ext *Extension, manifest *ExtensionManifest) error
}

// EntityTypeCreator is the subset of the entity service needed by the applier.
type EntityTypeCreator interface {
	CreateEntityType(ctx context.Context, campaignID string, input EntityTypeCreateInput) (EntityTypeResult, error)
}

// EntityTypeCreateInput mirrors entities.CreateEntityTypeInput to avoid
// importing the entities package directly.
type EntityTypeCreateInput struct {
	Name       string
	NamePlural string
	Icon       string
	Color      string
}

// EntityTypeResult is the minimal result needed from entity type creation.
type EntityTypeResult struct {
	ID   int
	Slug string
}

// TagCreator is the subset of the tag service needed by the applier.
type TagCreator interface {
	CreateTag(ctx context.Context, campaignID string, name, color string, dmOnly bool) (TagResult, error)
}

// TagResult is the minimal result from tag creation.
type TagResult struct {
	ID int
}

// contentApplier implements ContentApplier using domain service interfaces.
type contentApplier struct {
	extDir         string
	repo           ExtensionRepository
	entityTypes    EntityTypeCreator
	tags           TagCreator
}

// NewContentApplier creates an applier with the given service dependencies.
// Pass nil for any service that isn't available (the applier will skip those
// content types).
func NewContentApplier(
	extDir string,
	repo ExtensionRepository,
	entityTypes EntityTypeCreator,
	tags TagCreator,
) ContentApplier {
	return &contentApplier{
		extDir:      extDir,
		repo:        repo,
		entityTypes: entityTypes,
		tags:        tags,
	}
}

// Apply applies extension content to a campaign.
func (a *contentApplier) Apply(ctx context.Context, campaignID string, ext *Extension, manifest *ExtensionManifest) error {
	if manifest.Contributes == nil {
		return nil // Nothing to apply.
	}

	c := manifest.Contributes

	// Apply entity type templates.
	if a.entityTypes != nil && len(c.EntityTypeTemplates) > 0 {
		if err := a.applyEntityTypeTemplates(ctx, campaignID, ext.ID, c.EntityTypeTemplates); err != nil {
			slog.Warn("failed to apply entity type templates",
				slog.String("ext_id", ext.ExtID),
				slog.Any("error", err),
			)
		}
	}

	// Apply tag collections.
	if a.tags != nil && len(c.TagCollections) > 0 {
		if err := a.applyTagCollections(ctx, campaignID, ext.ID, c.TagCollections); err != nil {
			slog.Warn("failed to apply tag collections",
				slog.String("ext_id", ext.ExtID),
				slog.Any("error", err),
			)
		}
	}

	// Apply entity packs.
	if len(c.EntityPacks) > 0 {
		slog.Info("extension has entity packs — apply not yet implemented",
			slog.String("ext_id", ext.ExtID),
			slog.Int("count", len(c.EntityPacks)),
		)
	}

	// Apply calendar presets.
	if len(c.CalendarPresets) > 0 {
		slog.Info("extension has calendar presets — apply not yet implemented",
			slog.String("ext_id", ext.ExtID),
			slog.Int("count", len(c.CalendarPresets)),
		)
	}

	return nil
}

// applyEntityTypeTemplates creates entity types from templates.
func (a *contentApplier) applyEntityTypeTemplates(
	ctx context.Context,
	campaignID, extensionID string,
	templates []EntityTypeTemplate,
) error {
	for _, t := range templates {
		input := EntityTypeCreateInput{
			Name:       t.Name,
			NamePlural: t.NamePlural,
			Icon:       t.Icon,
			Color:      t.Color,
		}

		result, err := a.entityTypes.CreateEntityType(ctx, campaignID, input)
		if err != nil {
			slog.Warn("failed to create entity type from extension",
				slog.String("slug", t.Slug),
				slog.Any("error", err),
			)
			continue // Skip this template, try the next.
		}

		// Record provenance.
		if err := a.repo.CreateProvenance(ctx, &Provenance{
			CampaignID:  campaignID,
			ExtensionID: extensionID,
			TableName:   "entity_types",
			RecordID:    strconv.Itoa(result.ID),
			RecordType:  t.Slug,
		}); err != nil {
			slog.Warn("failed to record entity type provenance",
				slog.String("slug", t.Slug),
				slog.Any("error", err),
			)
		}

		slog.Info("applied entity type template",
			slog.String("name", t.Name),
			slog.String("slug", result.Slug),
		)
	}

	return nil
}

// applyTagCollections creates tags from collections.
func (a *contentApplier) applyTagCollections(
	ctx context.Context,
	campaignID, extensionID string,
	collections []TagCollection,
) error {
	for _, coll := range collections {
		for _, tag := range coll.Tags {
			color := tag.Color
			if color == "" {
				color = "#6b7280" // Default gray.
			}

			result, err := a.tags.CreateTag(ctx, campaignID, tag.Name, color, false)
			if err != nil {
				slog.Warn("failed to create tag from extension",
					slog.String("tag", tag.Name),
					slog.String("collection", coll.Slug),
					slog.Any("error", err),
				)
				continue
			}

			// Record provenance.
			if err := a.repo.CreateProvenance(ctx, &Provenance{
				CampaignID:  campaignID,
				ExtensionID: extensionID,
				TableName:   "tags",
				RecordID:    strconv.Itoa(result.ID),
				RecordType:  coll.Slug,
			}); err != nil {
				slog.Warn("failed to record tag provenance",
					slog.String("tag", tag.Name),
					slog.Any("error", err),
				)
			}
		}

		slog.Info("applied tag collection",
			slog.String("collection", coll.Name),
			slog.Int("tags", len(coll.Tags)),
		)
	}

	return nil
}

