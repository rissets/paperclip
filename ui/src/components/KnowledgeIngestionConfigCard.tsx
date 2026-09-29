import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import {
  BookOpen,
  FileText,
  Cpu,
  Zap,
  ExternalLink,
  Save,
  Plus,
  ArrowRight,
  Layers,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToastActions } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import { dataSourcesApi } from "@/api/data-sources";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";

interface KnowledgeIngestionConfig {
  autoExtractEntities: boolean;
  generateSyntheticQueries: boolean;
  chunkStrategy: "semantic_boundary" | "fine_grained" | "large_context";
  embeddingModel: "text-embedding-v3" | "multilingual-dense" | "hybrid-local";
}

export function KnowledgeIngestionConfigCard({
  agent,
  companyId,
}: {
  agent: AgentDetailRecord;
  companyId?: string;
}) {
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const savedConfig: Partial<KnowledgeIngestionConfig> =
    (agent.metadata as any)?.knowledgeIngestionConfig || {};

  const [autoExtractEntities, setAutoExtractEntities] = useState<boolean>(
    savedConfig.autoExtractEntities !== false
  );
  const [generateSyntheticQueries, setGenerateSyntheticQueries] = useState<boolean>(
    savedConfig.generateSyntheticQueries !== false
  );
  const [chunkStrategy, setChunkStrategy] = useState<
    "semantic_boundary" | "fine_grained" | "large_context"
  >(savedConfig.chunkStrategy || "semantic_boundary");
  const [embeddingModel, setEmbeddingModel] = useState<
    "text-embedding-v3" | "multilingual-dense" | "hybrid-local"
  >(savedConfig.embeddingModel || "text-embedding-v3");

  const [isSaving, setIsSaving] = useState(false);

  // Fetch company data sources to display managed knowledge documents
  const dataSourcesQuery = useQuery({
    queryKey: ["data-sources", companyId],
    queryFn: () => (companyId ? dataSourcesApi.list(companyId) : Promise.resolve([])),
    enabled: Boolean(companyId),
  });

  const knowledgeSources = (dataSourcesQuery.data || []).filter(
    (ds) =>
      ds.sourceType === "rag_document" ||
      ds.metadata?.onboardedBy === agent.name
  );

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const nextConfig: KnowledgeIngestionConfig = {
        autoExtractEntities,
        generateSyntheticQueries,
        chunkStrategy,
        embeddingModel,
      };

      const updatedMetadata = {
        ...(typeof agent.metadata === "object" && agent.metadata !== null
          ? agent.metadata
          : {}),
        knowledgeIngestionConfig: nextConfig,
      };

      await agentsApi.update(agent.id, {
        metadata: updatedMetadata,
      });

      queryClient.invalidateQueries({ queryKey: ["agents", agent.id] });
      pushToast({
        title: "Configuration Saved",
        body: "RAG knowledge ingestion policies updated successfully.",
        tone: "success",
      });
    } catch (err: any) {
      pushToast({
        title: "Failed to Save",
        body: err?.message || "Could not update knowledge ingestion configuration.",
        tone: "error",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-border bg-card p-6 shadow-sm space-y-6"
      aria-labelledby="knowledge-ingestion-heading"
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-border pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h3
              id="knowledge-ingestion-heading"
              className="text-base font-semibold text-foreground flex items-center gap-2"
            >
              RAG Knowledge Ingestion &amp; Vector Retrieval Policies
              <Badge variant="outline" className="text-xs bg-muted">
                JEV Semantic RAG
              </Badge>
            </h3>
            <p className="text-xs text-muted-foreground">
              Automated recursive chunking, agentic entity extraction, and dense-sparse hybrid vector indexing.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving}
            className="flex items-center gap-1.5"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{isSaving ? "Saving..." : "Save Settings"}</span>
          </Button>
        </div>
      </div>

      {/* Engine & Vector Status Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Ingestion Engine
            </span>
            <Cpu className="h-4 w-4 text-primary" />
          </div>
          <div className="text-sm font-medium text-foreground">Autonomous Document Reasoner</div>
          <div className="flex flex-wrap gap-1 pt-1">
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              doc.domain_classify.v1
            </span>
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              doc.entity_extract.v1
            </span>
            <span className="font-mono text-xs text-muted-foreground bg-background px-1.5 py-0.5 rounded border border-border">
              doc.semantic_chunk.v1
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Vector &amp; RAG Engine
            </span>
            <Layers className="h-4 w-4 text-indigo-500" />
          </div>
          <div className="text-sm font-medium text-foreground flex items-center gap-1.5">
            <span>Hybrid Dense + Sparse Index</span>
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          </div>
          <p className="text-xs text-muted-foreground">
            Chunk-level cosine similarity indexing with BM25 keyword boosting and query routing.
          </p>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Supported Formats
            </span>
            <Zap className="h-4 w-4 text-amber-500" />
          </div>
          <div className="flex flex-wrap gap-1.5 pt-1">
            <Badge variant="secondary" className="text-xs">
              PDF (.pdf)
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Markdown (.md)
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Word (.docx)
            </Badge>
            <Badge variant="secondary" className="text-xs">
              Text (.txt)
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Batch document ingestion with automatic executive summary and topic synthesis.
          </p>
        </div>
      </div>

      {/* Config Form Controls */}
      <div className="rounded-lg border border-border p-4 bg-card space-y-4">
        <h4 className="text-xs font-semibold text-foreground uppercase tracking-wider">
          Knowledge Ingestion &amp; Retrieval Preferences
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5 pr-2">
              <span className="text-sm font-medium text-foreground">
                Autonomous Entity &amp; Topic Extraction
              </span>
              <p className="text-xs text-muted-foreground">
                Run agentic reasoning loops to discover business entities and operational topics during onboarding.
              </p>
            </div>
            <ToggleSwitch
              checked={autoExtractEntities}
              onCheckedChange={setAutoExtractEntities}
            />
          </div>

          <div className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/20">
            <div className="space-y-0.5 pr-2">
              <span className="text-sm font-medium text-foreground">
                Synthesize Retrieval Questions
              </span>
              <p className="text-xs text-muted-foreground">
                Pre-generate high-value semantic retrieval questions to warm the agent query cache.
              </p>
            </div>
            <ToggleSwitch
              checked={generateSyntheticQueries}
              onCheckedChange={setGenerateSyntheticQueries}
            />
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <label className="text-sm font-medium text-foreground block">
              Chunking Strategy
            </label>
            <Select
              value={chunkStrategy}
              onValueChange={(val: any) => setChunkStrategy(val)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select chunking strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="semantic_boundary">
                  Semantic Boundary (500 tokens, 10% overlap - Recommended)
                </SelectItem>
                <SelectItem value="fine_grained">
                  Fine-Grained Paragraph (250 tokens, 15% overlap)
                </SelectItem>
                <SelectItem value="large_context">
                  Large Context Window (1,000 tokens, 5% overlap)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Controls document segmentation granularity for vector chunk storage and retrieval.
            </p>
          </div>

          <div className="p-3 rounded-lg border border-border bg-muted/20 space-y-2">
            <label className="text-sm font-medium text-foreground block">
              Embedding &amp; Retrieval Model
            </label>
            <Select
              value={embeddingModel}
              onValueChange={(val: any) => setEmbeddingModel(val)}
            >
              <SelectTrigger className="w-full text-xs">
                <SelectValue placeholder="Select embedding model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text-embedding-v3">
                  Text Embedding v3 (Dense 1536-dim, High Accuracy)
                </SelectItem>
                <SelectItem value="multilingual-dense">
                  Multilingual Semantic Vector (Dense 1024-dim)
                </SelectItem>
                <SelectItem value="hybrid-local">
                  Hybrid Dense + BM25 Sparse Index (768-dim)
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Target vector dimension and embedding model used for similarity indexing.
            </p>
          </div>
        </div>
      </div>

      {/* Managed Knowledge Documents List */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <BookOpen className="h-4 w-4 text-primary" /> Managed Knowledge Documents (
            {knowledgeSources.length})
          </h4>
          <Link
            to="/data-sources"
            className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
          >
            <span>+ Onboard Knowledge Document</span>
            <ArrowRight className="h-3 w-3" />
          </Link>
        </div>

        {knowledgeSources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center space-y-2">
            <FileText className="h-8 w-8 mx-auto text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">
              No unstructured knowledge documents currently onboarded.
            </p>
            <Link to="/data-sources">
              <Button size="sm" variant="outline" className="mt-2 text-xs">
                <Plus className="h-3.5 w-3.5 mr-1" /> Onboard First Document
              </Button>
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {knowledgeSources.map((ds) => {
              const chunkCount =
                (ds.metadata as any)?.chunkCount || ds.chunks?.length || 1;
              const domain = ds.semanticProfile?.domain;

              return (
                <div
                  key={ds.id}
                  className="rounded-lg border border-border bg-muted/20 p-4 space-y-2.5 transition-all hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        to={`/data-sources/${ds.id}`}
                        className="font-medium text-sm text-foreground hover:text-primary hover:underline truncate block"
                      >
                        {ds.name}
                      </Link>
                      <span className="text-xs text-muted-foreground uppercase font-mono">
                        {ds.sourceType}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge
                        variant={ds.status === "ready" ? "secondary" : "outline"}
                        className="text-xs"
                      >
                        {ds.status}
                      </Badge>
                      <Badge
                        variant="secondary"
                        className="text-xs bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
                      >
                        <Sparkles className="h-3 w-3 mr-1" />
                        RAG Active
                      </Badge>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border">
                    <span className="truncate max-w-48">
                      {chunkCount} chunk{chunkCount !== 1 ? "s" : ""}
                      {domain ? ` · ${domain}` : ""}
                    </span>
                    <Link
                      to={`/data-sources/${ds.id}`}
                      className="text-primary hover:underline flex items-center gap-1 shrink-0"
                    >
                      <span>View Knowledge</span>
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
