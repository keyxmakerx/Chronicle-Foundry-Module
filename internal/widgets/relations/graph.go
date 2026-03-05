package relations

import (
	"fmt"
	"net/http"

	"github.com/labstack/echo/v4"

	"github.com/keyxmakerx/chronicle/internal/apperror"
	"github.com/keyxmakerx/chronicle/internal/middleware"
	"github.com/keyxmakerx/chronicle/internal/plugins/campaigns"
)

// GraphNode represents an entity as a node in the relations graph.
// Each entity appears once regardless of how many relations it has.
type GraphNode struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Icon  string `json:"icon"`
	Color string `json:"color"`
	Type  string `json:"type"`
	Slug  string `json:"slug"`
	URL   string `json:"url"`
}

// GraphEdge represents a relation as an edge between two entity nodes.
// Bidirectional relation pairs are deduplicated to a single edge.
type GraphEdge struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Label  string `json:"label"`
}

// GraphData is the combined nodes+edges response for the graph API.
type GraphData struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

// GraphAPI returns the relations graph data for a campaign as JSON.
// Deduplicates bidirectional relation pairs into single edges and
// builds a unique node list from all participating entities.
// GET /campaigns/:id/relations/graph
func (h *Handler) GraphAPI(c echo.Context) error {
	cc := campaigns.GetCampaignContext(c)
	if cc == nil {
		return apperror.NewMissingContext()
	}

	relations, err := h.service.ListByCampaign(c.Request().Context(), cc.Campaign.ID)
	if err != nil {
		return err
	}

	// Build unique node map and deduplicated edge list.
	nodeMap := make(map[string]GraphNode)
	edgeSeen := make(map[string]bool)
	var edges []GraphEdge

	for _, rel := range relations {
		// Add source entity as node if not seen.
		if _, ok := nodeMap[rel.SourceEntityID]; !ok {
			nodeMap[rel.SourceEntityID] = GraphNode{
				ID:    rel.SourceEntityID,
				Name:  rel.SourceEntityName,
				Icon:  rel.SourceEntityIcon,
				Color: rel.SourceEntityColor,
				Type:  rel.SourceEntityType,
				Slug:  rel.SourceEntitySlug,
				URL:   fmt.Sprintf("/campaigns/%s/entities/%s", cc.Campaign.ID, rel.SourceEntityID),
			}
		}

		// Add target entity as node if not seen.
		if _, ok := nodeMap[rel.TargetEntityID]; !ok {
			nodeMap[rel.TargetEntityID] = GraphNode{
				ID:    rel.TargetEntityID,
				Name:  rel.TargetEntityName,
				Icon:  rel.TargetEntityIcon,
				Color: rel.TargetEntityColor,
				Type:  rel.TargetEntityType,
				Slug:  rel.TargetEntitySlug,
				URL:   fmt.Sprintf("/campaigns/%s/entities/%s", cc.Campaign.ID, rel.TargetEntityID),
			}
		}

		// Deduplicate bidirectional edges: use sorted pair as key.
		edgeKey := rel.SourceEntityID + "|" + rel.TargetEntityID
		reverseKey := rel.TargetEntityID + "|" + rel.SourceEntityID
		if !edgeSeen[edgeKey] && !edgeSeen[reverseKey] {
			edgeSeen[edgeKey] = true
			edges = append(edges, GraphEdge{
				Source: rel.SourceEntityID,
				Target: rel.TargetEntityID,
				Label:  rel.RelationType,
			})
		}
	}

	// Convert node map to slice.
	nodes := make([]GraphNode, 0, len(nodeMap))
	for _, node := range nodeMap {
		nodes = append(nodes, node)
	}

	// Return empty arrays instead of null.
	if nodes == nil {
		nodes = []GraphNode{}
	}
	if edges == nil {
		edges = []GraphEdge{}
	}

	return c.JSON(http.StatusOK, GraphData{Nodes: nodes, Edges: edges})
}

// GraphPage renders the standalone relations graph page.
// Returns full page or HTMX fragment based on request type.
// GET /campaigns/:id/relations
func (h *Handler) GraphPage(c echo.Context) error {
	cc := campaigns.GetCampaignContext(c)
	if cc == nil {
		return apperror.NewMissingContext()
	}

	if middleware.IsHTMX(c) {
		return middleware.Render(c, http.StatusOK, RelationGraphContent(cc))
	}
	return middleware.Render(c, http.StatusOK, RelationGraphPage(cc))
}
