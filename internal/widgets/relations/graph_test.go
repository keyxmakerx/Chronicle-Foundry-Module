package relations

import (
	"context"
	"testing"
)

// --- Graph Logic Tests ---
//
// These tests verify the deduplication logic used by GraphAPI to transform
// raw CampaignRelation rows into unique GraphNode/GraphEdge slices.

// buildGraphData simulates the core logic from GraphAPI for testability.
// It deduplicates nodes and bidirectional edge pairs.
func buildGraphData(relations []CampaignRelation, campaignID string) GraphData {
	nodeMap := make(map[string]GraphNode)
	edgeSeen := make(map[string]bool)
	var edges []GraphEdge

	for _, rel := range relations {
		if _, ok := nodeMap[rel.SourceEntityID]; !ok {
			nodeMap[rel.SourceEntityID] = GraphNode{
				ID:    rel.SourceEntityID,
				Name:  rel.SourceEntityName,
				Icon:  rel.SourceEntityIcon,
				Color: rel.SourceEntityColor,
				Type:  rel.SourceEntityType,
				Slug:  rel.SourceEntitySlug,
			}
		}
		if _, ok := nodeMap[rel.TargetEntityID]; !ok {
			nodeMap[rel.TargetEntityID] = GraphNode{
				ID:    rel.TargetEntityID,
				Name:  rel.TargetEntityName,
				Icon:  rel.TargetEntityIcon,
				Color: rel.TargetEntityColor,
				Type:  rel.TargetEntityType,
				Slug:  rel.TargetEntitySlug,
			}
		}

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

	nodes := make([]GraphNode, 0, len(nodeMap))
	for _, node := range nodeMap {
		nodes = append(nodes, node)
	}
	if nodes == nil {
		nodes = []GraphNode{}
	}
	if edges == nil {
		edges = []GraphEdge{}
	}
	return GraphData{Nodes: nodes, Edges: edges}
}

func TestBuildGraphData_EmptyInput(t *testing.T) {
	data := buildGraphData(nil, "camp-1")
	if len(data.Nodes) != 0 {
		t.Errorf("expected 0 nodes, got %d", len(data.Nodes))
	}
	if len(data.Edges) != 0 {
		t.Errorf("expected 0 edges, got %d", len(data.Edges))
	}
}

func TestBuildGraphData_DeduplicatesNodes(t *testing.T) {
	// Entity A appears as source in two different relations.
	relations := []CampaignRelation{
		{
			SourceEntityID: "a", SourceEntityName: "Alice", SourceEntityIcon: "fa-user", SourceEntityColor: "#f00",
			TargetEntityID: "b", TargetEntityName: "Bob", TargetEntityIcon: "fa-user", TargetEntityColor: "#0f0",
			RelationType: "allied with",
		},
		{
			SourceEntityID: "a", SourceEntityName: "Alice", SourceEntityIcon: "fa-user", SourceEntityColor: "#f00",
			TargetEntityID: "c", TargetEntityName: "Charlie", TargetEntityIcon: "fa-user", TargetEntityColor: "#00f",
			RelationType: "enemy of",
		},
	}

	data := buildGraphData(relations, "camp-1")
	if len(data.Nodes) != 3 {
		t.Errorf("expected 3 nodes (A, B, C), got %d", len(data.Nodes))
	}
	if len(data.Edges) != 2 {
		t.Errorf("expected 2 edges, got %d", len(data.Edges))
	}
}

func TestBuildGraphData_DeduplicatesBidirectionalEdges(t *testing.T) {
	// A→B "parent of" and B→A "child of" are a bidirectional pair.
	relations := []CampaignRelation{
		{
			SourceEntityID: "a", SourceEntityName: "Alice",
			TargetEntityID: "b", TargetEntityName: "Bob",
			RelationType: "parent of",
		},
		{
			SourceEntityID: "b", SourceEntityName: "Bob",
			TargetEntityID: "a", TargetEntityName: "Alice",
			RelationType: "child of",
		},
	}

	data := buildGraphData(relations, "camp-1")
	if len(data.Nodes) != 2 {
		t.Errorf("expected 2 nodes, got %d", len(data.Nodes))
	}
	if len(data.Edges) != 1 {
		t.Errorf("expected 1 edge (deduplicated pair), got %d", len(data.Edges))
	}
}

func TestBuildGraphData_DistinctEdgesBetweenSameNodes(t *testing.T) {
	// Two different relation pairs between A→B should NOT be deduplicated
	// since they share the same edge key. This matches the current behavior:
	// only one edge per entity pair regardless of relation type.
	relations := []CampaignRelation{
		{
			SourceEntityID: "a", SourceEntityName: "Alice",
			TargetEntityID: "b", TargetEntityName: "Bob",
			RelationType: "parent of",
		},
		{
			SourceEntityID: "a", SourceEntityName: "Alice",
			TargetEntityID: "b", TargetEntityName: "Bob",
			RelationType: "allied with",
		},
	}

	data := buildGraphData(relations, "camp-1")
	// Both have same source/target pair, so only one edge.
	if len(data.Edges) != 1 {
		t.Errorf("expected 1 edge (same pair), got %d", len(data.Edges))
	}
}

// --- Mock ListByCampaign ---

func TestListByCampaign_ServicePassthrough(t *testing.T) {
	expected := []CampaignRelation{
		{SourceEntityID: "a", TargetEntityID: "b", RelationType: "allied with"},
	}

	repo := &mockRelationRepo{
		listByCampaignFn: func(_ context.Context, campaignID string) ([]CampaignRelation, error) {
			if campaignID != "camp-1" {
				t.Errorf("unexpected campaign ID: %s", campaignID)
			}
			return expected, nil
		},
	}

	svc := NewRelationService(repo)
	result, err := svc.ListByCampaign(context.Background(), "camp-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 {
		t.Errorf("expected 1 relation, got %d", len(result))
	}
}
