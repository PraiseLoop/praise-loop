import { NextResponse } from "next/server";
import { ownerRoute, currentOwner } from "../../../../lib/authorization";
import { resolveUnknown } from "../../../../lib/services/postingSlots";

// The owner reports what happened to a post whose outcome we could not prove. Owner-only.
export const POST=ownerRoute(async req=>{
  const body=await req.json().catch(()=>null);
  const draftPostId=Number(body?.draftPostId);
  if(!Number.isSafeInteger(draftPostId)||draftPostId<=0||!["posted","not_posted"].includes(body?.outcome))return NextResponse.json({error:"draftPostId and outcome (posted or not_posted) are required"},{status:400});
  const result=await resolveUnknown(currentOwner(),draftPostId,body.outcome);
  return NextResponse.json(result.status===200?{ok:true}:{error:result.error},{status:result.status});
});
