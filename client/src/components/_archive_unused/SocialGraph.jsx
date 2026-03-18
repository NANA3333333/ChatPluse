import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

const SocialGraph = ({ userProfile, contacts, apiUrl, onClose }) => {
    const fgRef = useRef();
    const [graphData, setGraphData] = useState({ nodes: [], links: [] });
    const [hoverNode, setHoverNode] = useState(null);
    const [hoverLink, setHoverLink] = useState(null);
    const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });

    // Handle resize
    useEffect(() => {
        const handleResize = () => setDimensions({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // Fetch and build graph data
    useEffect(() => {
        const buildGraph = async () => {
            const nodes = [];
            const links = [];

            // 1. Add User Node
            const userId = userProfile?.id || 'user';
            nodes.push({
                id: userId,
                name: userProfile?.name || 'User',
                emoji: '👤', // Default user emoji
                isUser: true,
                val: 10 // Size
            });

            // 2. Add Character Nodes
            contacts.forEach(c => {
                nodes.push({
                    id: c.id,
                    name: c.name,
                    emoji: c.emoji || '🤖', // Use character emoji
                    isUser: false,
                    val: 8
                });
            });

            // 3. Fetch relationships for all contacts to build Links
            const token = localStorage.getItem('token');
            const linkSet = new Set(); // Prevent duplicates A->B and B->A

            for (const c of contacts) {
                try {
                    const res = await fetch(`${apiUrl}/characters/${c.id}/relationships`, {
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    if (res.ok) {
                        const rels = await res.json();
                        for (const rel of rels) {
                            if (!rel.isAcquainted) continue; // Only draw lines between people who know each other

                            // Sort IDs to ensure undirected edge uniqueness
                            const source = rel.sourceId;
                            const target = rel.targetId;
                            const linkId = [source, target].sort().join('-');

                            if (!linkSet.has(linkId)) {
                                linkSet.add(linkId);
                                links.push({
                                    source,
                                    target,
                                    affinity: rel.affinity,
                                    impression: rel.impression,
                                    id: linkId
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error fetching relationships for", c.name, e);
                }
            }

            setGraphData({ nodes, links });
        };

        if (contacts.length > 0) {
            buildGraph();
        }
    }, [contacts, apiUrl, userProfile]);

    // Force graph to center after data loads
    useEffect(() => {
        if (fgRef.current && graphData.nodes.length > 0) {
            setTimeout(() => {
                fgRef.current.d3Force('charge').strength(-400); // Repel nodes more strongly
                fgRef.current.d3Force('link').distance(100);    // Lines are longer
                fgRef.current.zoomToFit(400, 50);
            }, 300);
        }
    }, [graphData]);

    const getLinkColor = (affinity) => {
        if (affinity >= 80) return 'rgba(255, 99, 132, 0.8)'; // Red/Pink (Close)
        if (affinity >= 40) return 'rgba(75, 192, 192, 0.6)'; // Green (Friendly)
        return 'rgba(54, 162, 235, 0.4)'; // Blue (Distant/Dislike)
    };

    const handleNodeHover = useCallback(node => {
        setHoverNode(node);
        document.body.style.cursor = node ? 'pointer' : 'default';
    }, []);

    const handleLinkHover = useCallback(link => {
        setHoverLink(link);
    }, []);

    // Custom Canvas rendering for Emoji Nodes
    const paintNode = useCallback((node, ctx, globalScale) => {
        const label = node.emoji || '👤';
        const fontSize = 16 / globalScale;
        ctx.font = `${fontSize}px Arial`;
        const textWidth = ctx.measureText(label).width;
        const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2); // some padding

        // Draw background circle
        ctx.fillStyle = node.isUser ? 'rgba(255, 206, 86, 0.2)' : 'rgba(255, 255, 255, 0.1)';
        ctx.beginPath();
        ctx.arc(node.x, node.y, bckgDimensions[0] / 1.5, 0, 2 * Math.PI, false);
        ctx.fill();

        // Draw highlight if hovered
        if (hoverNode === node) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1 / globalScale;
            ctx.stroke();
        }

        // Draw Emoji
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#fff';
        ctx.fillText(label, node.x, node.y);

        // Draw Name underneath if zoomed in enough or hovered
        if (globalScale > 1.5 || hoverNode === node) {
            ctx.font = `${fontSize * 0.5}px Arial`;
            ctx.fillText(node.name, node.x, node.y + (bckgDimensions[0] / 1.5) + (fontSize * 0.5));
        }
    }, [hoverNode]);

    return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#111827', zIndex: 9999 }}>
            {/* Header */}
            <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 10, display: 'flex', alignItems: 'center', gap: '15px' }}>
                <button
                    onClick={onClose}
                    className="p-2 bg-gray-800 text-white rounded-full hover:bg-gray-700 transition"
                    style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                >
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                </button>
                <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-emerald-400">
                    Social Web 关系网
                </h1>
            </div>

            {/* Legend */}
            <div className="absolute top-20 left-20 z-10 bg-gray-800/80 p-4 rounded-xl border border-gray-700 backdrop-blur-sm text-sm text-gray-300">
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-1 rounded bg-[rgba(255,99,132,0.8)]"></div> <span>挚友/心动 (Affinity &ge; 80)</span>
                </div>
                <div className="flex items-center gap-2 mb-2">
                    <div className="w-8 h-1 rounded bg-[rgba(75,192,192,0.6)]"></div> <span>熟人/友好 (Affinity 40-79)</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-8 h-1 rounded bg-[rgba(54,162,235,0.4)]"></div> <span>陌生/反感 (Affinity &lt; 40)</span>
                </div>
            </div>

            {/* Force Graph */}
            <ForceGraph2D
                ref={fgRef}
                width={dimensions.width}
                height={dimensions.height}
                graphData={graphData}
                nodeLabel="name"
                nodeCanvasObject={paintNode}
                nodePointerAreaPaint={(node, color, ctx) => {
                    ctx.fillStyle = color;
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI, false);
                    ctx.fill();
                }}
                linkColor={link => getLinkColor(link.affinity)}
                linkWidth={link => hoverLink === link ? 4 : 2}
                onNodeHover={handleNodeHover}
                onLinkHover={handleLinkHover}
                linkDirectionalParticles={2}
                linkDirectionalParticleSpeed={d => d.affinity * 0.0001}
                cooldownTicks={100}
            />

            {/* Floating Tooltip for Links */}
            {hoverLink && hoverLink.source?.name && hoverLink.target?.name && (
                <div
                    className="absolute z-20 bg-gray-900 border border-gray-700 p-4 rounded-xl shadow-2xl max-w-sm pointer-events-none"
                    style={{
                        top: dimensions.height / 2 + 50,
                        left: dimensions.width / 2,
                        transform: 'translate(-50%, -50%)',
                        background: 'rgba(17, 24, 39, 0.95)',
                        backdropFilter: 'blur(8px)'
                    }}
                >
                    <div className="flex items-center justify-between mb-3 border-b border-gray-800 pb-2">
                        <div className="flex flex-col items-center">
                            <span className="text-2xl">{hoverLink.source.emoji}</span>
                            <span className="text-xs text-gray-400 mt-1">{hoverLink.source.name}</span>
                        </div>
                        <div className="flex flex-col flex-1 mx-4 items-center">
                            <div className="text-xs text-gray-500 mb-1">Affinity</div>
                            <div className={`text-xl font-bold ${hoverLink.affinity >= 80 ? 'text-pink-400' : hoverLink.affinity >= 40 ? 'text-emerald-400' : 'text-blue-400'}`}>
                                {hoverLink.affinity}
                            </div>
                            <div className="h-px w-full bg-gray-700 my-1"></div>
                        </div>
                        <div className="flex flex-col items-center">
                            <span className="text-2xl">{hoverLink.target.emoji}</span>
                            <span className="text-xs text-gray-400 mt-1">{hoverLink.target.name}</span>
                        </div>
                    </div>
                    <div className="text-sm text-gray-300 italic">
                        "{hoverLink.impression || '暂无印象'}"
                    </div>
                </div>
            )}
        </div>
    );
};

export default SocialGraph;
