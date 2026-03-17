// service.go contains business logic for the Armory gallery. Resolves the
// campaign's item-category entity types and delegates listing to the repository.
package armory

import (
	"context"
	"fmt"
)

// ItemTypeFinder resolves item-category entity types for a campaign.
// Implemented by the entities.EntityService — injected to avoid circular imports.
type ItemTypeFinder interface {
	FindItemTypeIDs(ctx context.Context, campaignID string) ([]int, error)
	FindItemTypes(ctx context.Context, campaignID string) ([]ItemTypeInfo, error)
}

// TagLister fetches tags for a set of entity IDs in batch.
// Implemented by tags.TagService — injected to decorate item cards with tags.
type TagLister interface {
	ListTagsForEntities(ctx context.Context, entityIDs []string) (map[string][]TagInfo, error)
}

// TagInfo holds tag display data returned by TagLister.
type TagInfo struct {
	ID    int
	Name  string
	Slug  string
	Color string
}

// ArmoryService handles business logic for the Armory gallery.
type ArmoryService interface {
	// ListItems returns item entities for the Armory gallery.
	ListItems(ctx context.Context, campaignID string, role int, userID string, opts ItemListOptions) ([]ItemCard, int, error)

	// CountItems returns the number of visible items for badge/nav display.
	CountItems(ctx context.Context, campaignID string, role int, userID string) (int, error)

	// GetItemTypes returns all item-category entity types for filter dropdowns.
	GetItemTypes(ctx context.Context, campaignID string) ([]ItemTypeInfo, error)
}

// armoryService implements ArmoryService.
type armoryService struct {
	repo       ArmoryRepository
	typeFinder ItemTypeFinder
	tagLister  TagLister
}

// NewArmoryService creates a new Armory service.
func NewArmoryService(repo ArmoryRepository, typeFinder ItemTypeFinder) ArmoryService {
	return &armoryService{repo: repo, typeFinder: typeFinder}
}

// SetTagLister injects the tag batch fetcher for card decoration.
func (s *armoryService) SetTagLister(tl TagLister) {
	s.tagLister = tl
}

// ListItems resolves item types and queries for items.
func (s *armoryService) ListItems(ctx context.Context, campaignID string, role int, userID string, opts ItemListOptions) ([]ItemCard, int, error) {
	typeIDs, err := s.typeFinder.FindItemTypeIDs(ctx, campaignID)
	if err != nil {
		return nil, 0, fmt.Errorf("resolving item types: %w", err)
	}

	// No item types configured — return empty rather than error.
	if len(typeIDs) == 0 {
		return nil, 0, nil
	}

	cards, total, err := s.repo.ListItems(ctx, campaignID, typeIDs, role, userID, opts)
	if err != nil {
		return nil, 0, err
	}

	// Decorate with tags if available.
	if s.tagLister != nil && len(cards) > 0 {
		ids := make([]string, len(cards))
		for i := range cards {
			ids[i] = cards[i].ID
		}
		tagMap, err := s.tagLister.ListTagsForEntities(ctx, ids)
		if err == nil {
			for i := range cards {
				if infos, ok := tagMap[cards[i].ID]; ok {
					for _, t := range infos {
						cards[i].Tags = append(cards[i].Tags, ItemTagInfo(t))
					}
				}
			}
		}
	}

	return cards, total, nil
}

// CountItems resolves item types and returns the visible count.
func (s *armoryService) CountItems(ctx context.Context, campaignID string, role int, userID string) (int, error) {
	typeIDs, err := s.typeFinder.FindItemTypeIDs(ctx, campaignID)
	if err != nil {
		return 0, fmt.Errorf("resolving item types: %w", err)
	}
	if len(typeIDs) == 0 {
		return 0, nil
	}
	return s.repo.CountItems(ctx, campaignID, typeIDs, role, userID)
}

// GetItemTypes returns item-category entity types for the type filter dropdown.
func (s *armoryService) GetItemTypes(ctx context.Context, campaignID string) ([]ItemTypeInfo, error) {
	return s.typeFinder.FindItemTypes(ctx, campaignID)
}
