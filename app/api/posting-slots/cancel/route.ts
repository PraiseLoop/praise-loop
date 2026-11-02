import { NextResponse } from "next/server";
import { ownerRoute, currentOwner } from "../../../../lib/authorization";
import { cancelScheduled } from "../../../../lib/services/postingSlots";

// Take a scheduled post back before it is sent to Buffer. Owner-only; another owner's draft is a 404.
export const POST=ownerRoute(async req=>{
  const body=await req.json().catch(()=>null);
  const draftPostId=Number(body?.draftPostId);
  if(!Number.isSafeInteger(draftPostId)||draftPostId<=0)return NextResponse.json({error:"valid draftPostId is required"},{status:400});
  const result=await cancelScheduled(currentOwner(),draftPostId);
  return NextResponse.json(result.status===200?{ok:true}:{error:result.error},{status:result.status});
});
