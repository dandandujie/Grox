import { Mascot } from "@/components/Mascot";
import { generateAvatar } from "@/lib/pixel-avatar";

const SEEDS = [
  "Brody", "GitScout", "Emaily", "Omiii", "Onyx", "Grox", "Launch room", "Ada",
  "Grace", "Alan", "Margaret", "Ken", "Kieran", "Guido", "Notion", "Simone",
  "Kiki", "Oscar", "Alonzo", "Sasha", "Agent 6", "Agent 13",
];

export function AvatarGallery() {
  return (
    <div className="avatar-gallery">
      <header className="avatar-gallery-head">
        <div>
          <h2>Generated portraits</h2>
        </div>
        <a href="/" className="btn btn-secondary">Back to Grox</a>
      </header>
      <div className="avatar-gallery-grid">
        {SEEDS.map((seed) => {
          const avatar = generateAvatar(seed);
          return (
            <article key={seed} className="avatar-gallery-card">
              <Mascot seed={seed} title={seed} size={42} />
              <div>
                <div className="avatar-gallery-name">{seed}</div>
                <div className="avatar-gallery-layer">{avatar.name}</div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
